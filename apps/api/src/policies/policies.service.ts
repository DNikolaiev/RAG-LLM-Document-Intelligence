import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { loadConfig } from '@caselens/config';
import type {
  DomainPackConfiguration,
  FieldProposal,
  RegistryCollection,
  RegistryRule,
  Severity,
} from '@caselens/contracts';
import { validateFile } from '@caselens/document-pipeline';
import {
  assertPolicyTransition,
  assertProposalTransition,
  parseDomainPack,
  resolvePersistedDomainPack,
  validateRuleProposal,
  type DomainPack,
  type PolicyRuleProposal,
} from '@caselens/domain';
import {
  PostgresCaseStore,
  PostgresPolicyStore,
  nextMinorVersion,
  type AccessScope,
  type FieldProposalStatus,
  type SavePackVersionInput,
  type StoredFieldProposal,
  type StoredPolicyProposalDetail,
} from '@caselens/persistence';
import {
  BullMqQueueProvider,
  DeterministicVirusScanner,
  S3CompatibleStorageProvider,
} from '@caselens/providers';
import type { RequestContext } from '../request-context.js';

export const GENERAL_CONTROLS_COLLECTION = {
  id: 'general-controls',
  label: 'General controls',
} as const;

export interface RegistryPolicySource {
  id: string;
  title: string;
  collectionId: string;
}

export interface RegistryPolicyRule {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  policyDocumentId: string;
  policyVersion: string;
}

/**
 * Builds the tenant rule registry: one array in which every active rule declares the collection it
 * belongs to and the origin it came from. A domain-pack rule without a declared collection falls
 * into the synthetic `general-controls` collection, which is appended to the collection list only
 * when at least one rule lands in it.
 */
export function buildRuleRegistry(
  pack: DomainPack,
  activePolicies: readonly RegistryPolicySource[],
  activePolicyRules: readonly RegistryPolicyRule[],
): { collections: RegistryCollection[]; rules: RegistryRule[] } {
  const policyById = new Map(activePolicies.map((policy) => [policy.id, policy]));
  const domainPackRules: RegistryRule[] = pack.rules.map((rule) => ({
    id: rule.id,
    title: rule.title,
    description: rule.description,
    severity: rule.severity,
    collectionId: rule.collectionId ?? GENERAL_CONTROLS_COLLECTION.id,
    origin: {
      kind: 'domain_pack',
      domainPackName: pack.name,
      domainPackVersion: pack.version,
    },
  }));
  const policyDerivedRules: RegistryRule[] = activePolicyRules.flatMap((rule) => {
    const policy = policyById.get(rule.policyDocumentId);
    if (!policy) return [];
    return [
      {
        id: rule.id,
        title: rule.title,
        description: rule.description,
        severity: rule.severity,
        collectionId: policy.collectionId,
        origin: {
          kind: 'policy_document',
          policyId: policy.id,
          policyTitle: policy.title,
          policyVersion: rule.policyVersion,
        },
      },
    ];
  });
  const rules = [...domainPackRules, ...policyDerivedRules];
  const collections: RegistryCollection[] = pack.policyCollections.map((collection) => ({
    id: collection.id,
    label: collection.label,
  }));
  const usesGeneralControls = rules.some(
    (rule) => rule.collectionId === GENERAL_CONTROLS_COLLECTION.id,
  );
  const declaresGeneralControls = collections.some(
    (collection) => collection.id === GENERAL_CONTROLS_COLLECTION.id,
  );
  if (usesGeneralControls && !declaresGeneralControls) {
    collections.push({ ...GENERAL_CONTROLS_COLLECTION });
  }
  return { collections, rules };
}

/**
 * Administrator gate shared by every policy-governance mutation. Extracted to module scope (the
 * class method below just delegates to it) so the field-proposal approve/reject logic can be
 * unit tested against a plain `RequestContext` object without instantiating `PoliciesService` -
 * whose constructor otherwise composes real Postgres/S3/BullMQ clients under the production-local
 * profile.
 */
export function requireAdministrator(context: RequestContext): void {
  if (context.role !== 'admin') {
    throw new ForbiddenException({
      code: 'POLICY_ADMIN_REQUIRED',
      message: 'Only tenant or platform administrators can manage policies.',
    });
  }
}

/**
 * The narrow slice of `FieldDictionaryStore` (`@caselens/persistence`) that field-proposal
 * approval and rejection need. A `PostgresPolicyStore` satisfies this structurally, but tests can
 * hand in a minimal in-memory stand-in instead of implementing the whole dictionary surface
 * (embedding search, fingerprint listing, proposal batch-save) that approval never touches.
 */
export interface FieldProposalGovernanceStore {
  getFieldProposal(tenantId: string, id: string): Promise<StoredFieldProposal | null>;
  getActivePackDefinition(tenantId: string, domainPackId: string): Promise<DomainPack | null>;
  savePackVersion(input: SavePackVersionInput): Promise<{ semanticVersion: string }>;
  setFieldProposalStatus(
    tenantId: string,
    id: string,
    status: FieldProposalStatus,
    actorUserId: string,
    reason?: string,
  ): Promise<void>;
}

/**
 * Maps a stored proposal (which carries review bookkeeping and a 768-float embedding) down to
 * the `FieldProposal` contract shared with the review console.
 */
export function toFieldProposalResponse(stored: StoredFieldProposal): FieldProposal {
  return {
    id: stored.id,
    tenantId: stored.tenantId,
    domainPackId: stored.domainPackId,
    policyDocumentId: stored.policyDocumentId,
    kind: stored.kind,
    documentTypeId: stored.documentTypeId,
    path: stored.path,
    label: stored.label,
    fieldType: stored.fieldType,
    aliases: [...stored.aliases],
    citation: { ...stored.citation },
    dedup: { ...stored.dedup },
    status: stored.status,
    issues: stored.issues.map((issue) => ({ ...issue })),
  };
}

/**
 * Builds the next pack definition for one proposal, then re-validates the WHOLE pack through
 * `parseDomainPack` before anything is persisted. Pure and synchronous: no store is touched, so a
 * proposal that no longer applies - its document type is gone, its field vanished, or a new field
 * now collides on path - throws before a single byte is written, never leaving a partial pack.
 *
 * `kind: 'new_field'` appends a field to the named document type's `extractionFields`.
 * `kind: 'alias'` appends only the wording the proposal carries to the *existing* field's
 * aliases (wording already present is not duplicated).
 */
export function applyFieldProposal(pack: DomainPack, proposal: StoredFieldProposal): DomainPack {
  const documentTypeIndex = pack.documentTypes.findIndex(
    (documentType) => documentType.id === proposal.documentTypeId,
  );
  if (documentTypeIndex === -1) {
    throw new ConflictException({
      code: 'FIELD_PROPOSAL_DOCUMENT_TYPE_NOT_FOUND',
      message: `The "${proposal.documentTypeId}" document type no longer exists in this domain pack.`,
    });
  }
  const documentType = pack.documentTypes[documentTypeIndex]!;
  let nextDocumentType: DomainPack['documentTypes'][number];
  if (proposal.kind === 'new_field') {
    if (documentType.extractionFields.some((field) => field.path === proposal.path)) {
      throw new ConflictException({
        code: 'FIELD_PROPOSAL_PATH_COLLISION',
        message: `A field already exists at path "${proposal.path}" on "${proposal.documentTypeId}".`,
      });
    }
    nextDocumentType = {
      ...documentType,
      extractionFields: [
        ...documentType.extractionFields,
        {
          path: proposal.path,
          label: proposal.label,
          type: proposal.fieldType,
          required: false,
          aliases: [...proposal.aliases],
        },
      ],
    };
  } else {
    const fieldIndex = documentType.extractionFields.findIndex(
      (field) => field.path === proposal.path,
    );
    if (fieldIndex === -1) {
      throw new ConflictException({
        code: 'FIELD_PROPOSAL_FIELD_NOT_FOUND',
        message: `The field at path "${proposal.path}" no longer exists on "${proposal.documentTypeId}".`,
      });
    }
    const field = documentType.extractionFields[fieldIndex]!;
    const existingAliases = new Set(field.aliases);
    const newAliases = proposal.aliases.filter((alias) => !existingAliases.has(alias));
    nextDocumentType = {
      ...documentType,
      extractionFields: documentType.extractionFields.map((candidate, index) =>
        index === fieldIndex ? { ...field, aliases: [...field.aliases, ...newAliases] } : candidate,
      ),
    };
  }
  const nextPack = {
    ...pack,
    documentTypes: pack.documentTypes.map((candidate, index) =>
      index === documentTypeIndex ? nextDocumentType : candidate,
    ),
  };
  try {
    return parseDomainPack(nextPack);
  } catch {
    throw new ConflictException({
      code: 'FIELD_PROPOSAL_PACK_INVALID',
      message: 'Applying this proposal would produce an invalid domain pack; it no longer applies.',
    });
  }
}

/**
 * Approve semantics for one field proposal: mint the next pack version and mark the proposal
 * approved, or - if it is already approved - return the version already minted without touching
 * the store again. Administrator-only, tenant-scoped by the caller-supplied `tenantId`, and safe
 * to call twice: the second call is a no-op that returns the same version, because the pack has
 * not moved since the first call minted it.
 *
 * Exported as a pure(ish) function over an injected store (rather than a `PoliciesService`
 * method) so it can be unit tested directly - `PoliciesService.runtime()` throws
 * `POLICY_LIBRARY_REQUIRES_PRODUCTION_LOCAL` outside the production-local profile, which the
 * demo-mode Nest test harness never composes.
 */
export async function approveFieldProposal(
  store: FieldProposalGovernanceStore,
  context: RequestContext,
  tenantId: string,
  proposalId: string,
  reason?: string,
): Promise<{ semanticVersion: string }> {
  requireAdministrator(context);
  const proposal = await store.getFieldProposal(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundException({
      code: 'FIELD_PROPOSAL_NOT_FOUND',
      message: 'Field proposal not found.',
    });
  }
  if (proposal.status === 'invalid') {
    throw new BadRequestException({
      code: 'INVALID_FIELD_PROPOSAL',
      message: 'A blocked field proposal cannot be approved until its validation issues are fixed.',
      issues: proposal.issues,
    });
  }
  if (proposal.status === 'rejected') {
    throw new ConflictException({
      code: 'FIELD_PROPOSAL_STATE_CONFLICT',
      message: 'This field proposal was already rejected and cannot be approved.',
    });
  }
  const activePack = await store.getActivePackDefinition(tenantId, proposal.domainPackId);
  if (!activePack) {
    throw new NotFoundException({
      code: 'DOMAIN_PACK_NOT_FOUND',
      message: 'No active domain pack is installed for this tenant.',
    });
  }
  if (proposal.status === 'approved') {
    // Idempotent replay: the field is already live in the active pack from the first approval.
    return { semanticVersion: activePack.version };
  }
  const nextDefinition = applyFieldProposal(activePack, proposal);
  const semanticVersion = nextMinorVersion(activePack.version);
  let minted: { semanticVersion: string };
  try {
    minted = await store.savePackVersion({
      tenantId,
      domainPackId: proposal.domainPackId,
      definition: nextDefinition,
      semanticVersion,
      supersedes: activePack.version,
      actorUserId: context.userId,
    });
  } catch (error) {
    throw translateFieldDictionaryError(error);
  }
  try {
    await store.setFieldProposalStatus(tenantId, proposal.id, 'approved', context.userId, reason);
  } catch (error) {
    throw translateFieldDictionaryError(error);
  }
  return minted;
}

/**
 * Reject semantics: records the actor and reason, and never touches the pack. Idempotent -
 * rejecting an already-rejected proposal is a no-op via `setFieldProposalStatus`. Exported for
 * the same direct-unit-test reason as `approveFieldProposal`.
 */
export async function rejectFieldProposal(
  store: FieldProposalGovernanceStore,
  context: RequestContext,
  tenantId: string,
  proposalId: string,
  reason?: string,
): Promise<{ status: 'rejected' }> {
  requireAdministrator(context);
  const proposal = await store.getFieldProposal(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundException({
      code: 'FIELD_PROPOSAL_NOT_FOUND',
      message: 'Field proposal not found.',
    });
  }
  if (proposal.status === 'approved') {
    throw new ConflictException({
      code: 'FIELD_PROPOSAL_STATE_CONFLICT',
      message: 'This field proposal was already approved and cannot be rejected.',
    });
  }
  try {
    await store.setFieldProposalStatus(tenantId, proposal.id, 'rejected', context.userId, reason);
  } catch (error) {
    throw translateFieldDictionaryError(error);
  }
  return { status: 'rejected' };
}

/**
 * Translates the raw, colon-tagged `Error`s that `domain-pack-store.ts`'s transaction functions
 * throw (never `HttpException`s - that module has no Nest dependency) into problem-details
 * responses. Anything unrecognized passes through unchanged.
 */
function translateFieldDictionaryError(error: unknown): unknown {
  if (error instanceof Error) {
    if (error.message.startsWith('FIELD_PROPOSAL_STATE_CONFLICT:')) {
      return new ConflictException({
        code: 'FIELD_PROPOSAL_STATE_CONFLICT',
        message: 'This field proposal was already reviewed with a different outcome.',
      });
    }
    if (error.message.startsWith('FIELD_PROPOSAL_NOT_FOUND:')) {
      return new NotFoundException({
        code: 'FIELD_PROPOSAL_NOT_FOUND',
        message: 'Field proposal not found.',
      });
    }
    if (
      error.message.startsWith('PACK_VERSION_CONFLICT:') ||
      error.message.startsWith('PACK_SUPERSEDES_NOT_FOUND:')
    ) {
      return new ConflictException({
        code: 'PACK_VERSION_CONFLICT',
        message: 'The domain pack changed concurrently. Retry the approval.',
      });
    }
    if (error.message.startsWith('DOMAIN_PACK_NOT_FOUND:')) {
      return new NotFoundException({
        code: 'DOMAIN_PACK_NOT_FOUND',
        message: 'No active domain pack is installed for this tenant.',
      });
    }
  }
  return error;
}

export interface PolicyUploadInput {
  tenantId?: string | undefined;
  title: string;
  policyVersion: string;
  collectionId: string;
  domainPackId?: string | undefined;
  language: string;
  validFrom: string;
  validTo?: string | undefined;
}

@Injectable()
export class PoliciesService implements OnModuleDestroy {
  readonly #store: PostgresPolicyStore | null;
  readonly #jobs: PostgresCaseStore | null;
  readonly #storage: S3CompatibleStorageProvider | null;
  readonly #queue: BullMqQueueProvider | null;
  readonly #allowSelfApproval: boolean;

  constructor() {
    const config = loadConfig();
    this.#allowSelfApproval =
      config.AUTH_MODE === 'test-profiles' && config.ENABLE_TEST_IDENTITY_SWITCHER;
    if (
      config.PERSISTENCE_PROVIDER !== 'postgres' ||
      config.STORAGE_PROVIDER !== 's3' ||
      config.QUEUE_PROVIDER !== 'bullmq'
    ) {
      this.#store = null;
      this.#jobs = null;
      this.#storage = null;
      this.#queue = null;
      return;
    }
    const redis = new URL(config.REDIS_URL!);
    this.#store = new PostgresPolicyStore(config.DATABASE_URL!);
    this.#jobs = new PostgresCaseStore(config.DATABASE_URL!);
    this.#storage = new S3CompatibleStorageProvider({
      id: 'local-minio-policy-library',
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      accessKeyId: config.S3_ACCESS_KEY!,
      secretAccessKey: config.S3_SECRET_KEY!,
      forcePathStyle: true,
    });
    this.#queue = new BullMqQueueProvider({
      id: 'local-bullmq-policy-library',
      queueName: config.QUEUE_NAME,
      connection: {
        host: redis.hostname,
        port: Number(redis.port || 6379),
        ...(redis.password ? { password: decodeURIComponent(redis.password) } : {}),
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.#store?.close(), this.#jobs?.close(), this.#storage?.close()]);
  }

  async list(context: RequestContext, filters: { status?: string; domainPackId?: string }) {
    this.requireAdministrator(context);
    if (!this.#store) return { items: [], nextCursor: null, mode: 'demo' };
    return {
      items: await this.#store.list(this.scope(context), filters),
      nextCursor: null,
      mode: 'production',
    };
  }

  /**
   * The tenant's field-proposal queue: candidate extraction fields an uploaded policy proposed,
   * deduplicated by `apps/worker`'s embedding-recall stage before ever reaching an administrator.
   * Requires the production-local profile like every other durable policy endpoint - there is no
   * demo-mode fallback, because there is no persisted field dictionary to list in demo mode.
   */
  async fieldProposals(
    context: RequestContext,
    filters: { tenantId?: string; status?: FieldProposalStatus },
  ): Promise<{ items: FieldProposal[] }> {
    this.requireAdministrator(context);
    const store = this.runtime().store;
    const tenantId = this.resolveTenant(context, filters.tenantId);
    const domainPackId = `pack_${tenantId}`;
    const proposals = await store.listFieldProposals(tenantId, domainPackId, filters.status);
    return { items: proposals.map(toFieldProposalResponse) };
  }

  /**
   * Thin wrapper delegating to the exported `approveFieldProposal`: resolves the tenant and hands
   * the durable store to the pure orchestrator, which is what the tests in
   * `policies.service.test.ts` exercise directly.
   */
  async approveFieldProposal(
    context: RequestContext,
    proposalId: string,
    input: { tenantId?: string | undefined; reason?: string | undefined },
  ): Promise<{ semanticVersion: string }> {
    const store = this.runtime().store;
    const tenantId = this.resolveTenant(context, input.tenantId);
    return approveFieldProposal(store, context, tenantId, proposalId, input.reason);
  }

  /** Thin wrapper delegating to the exported `rejectFieldProposal` - see `approveFieldProposal`. */
  async rejectFieldProposal(
    context: RequestContext,
    proposalId: string,
    input: { tenantId?: string | undefined; reason?: string | undefined },
  ): Promise<{ status: 'rejected' }> {
    const store = this.runtime().store;
    const tenantId = this.resolveTenant(context, input.tenantId);
    return rejectFieldProposal(store, context, tenantId, proposalId, input.reason);
  }

  /**
   * The domain-pack endpoint response. Typed as the shared `DomainPackConfiguration` contract, so
   * renaming or dropping a field the review console reads is a compile error on both sides rather
   * than a runtime surprise. `policies.endpoint.test.ts` asserts the emitted shape over HTTP.
   */
  async domainPackConfiguration(
    context: RequestContext,
    requestedTenantId?: string,
  ): Promise<DomainPackConfiguration> {
    this.requireAdministrator(context);
    const tenantId = this.resolveTenant(context, requestedTenantId);
    const domainPackId = `pack_${tenantId}`;
    const pack = resolvePersistedDomainPackId(domainPackId);
    if (!pack) {
      throw new NotFoundException({
        code: 'DOMAIN_PACK_NOT_FOUND',
        message: 'No domain pack is installed for the selected workspace.',
      });
    }
    const documentTypes = new Map(
      pack.documentTypes.map((documentType) => [documentType.id, documentType]),
    );
    const store = this.runtime().store;
    const [activePolicies, activePolicyRules] = await Promise.all([
      store.list(this.scopeForTenant(tenantId, context.userId), {
        domainPackId,
        status: 'active',
      }),
      store.listActiveRules(tenantId, domainPackId),
    ]);
    const registry = buildRuleRegistry(pack, activePolicies, activePolicyRules);

    return {
      tenantId,
      domainPack: {
        id: domainPackId,
        key: pack.id,
        name: pack.name,
        version: pack.version,
        terminology: pack.terminology,
        collections: registry.collections,
        requiredDocuments: pack.requiredDocuments.map((requirement) => ({
          id: requirement.id,
          documentType: requirement.documentType,
          documentLabel:
            documentTypes.get(requirement.documentType)?.label ?? requirement.documentType,
          severity: requirement.severity,
          message: requirement.message,
          conditional: Boolean(requirement.when),
        })),
        documentTypes: pack.documentTypes.map((documentType) => ({
          id: documentType.id,
          label: documentType.label,
          description: documentType.description,
          fields: documentType.extractionFields.map((field) => ({
            path: field.path,
            label: field.label,
            type: field.type,
            required: field.required,
            aliases: field.aliases,
          })),
        })),
        rules: registry.rules,
      },
    };
  }

  async get(context: RequestContext, policyId: string) {
    this.requireAdministrator(context);
    const store = this.runtime().store;
    const policy = await store.getDetail(this.scope(context), policyId);
    if (!policy)
      throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: 'Policy not found.' });
    return policy;
  }

  async content(context: RequestContext, policyId: string) {
    const { store, storage } = this.runtime();
    this.requireAdministrator(context);
    const policy = await store.get(this.scope(context), policyId);
    if (!policy)
      throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: 'Policy not found.' });
    const result = await storage.get(policy.storageKey);
    if (!result.ok) {
      throw new ServiceUnavailableException({
        code: 'POLICY_STORAGE_UNAVAILABLE',
        message: 'The original policy file is not currently available.',
      });
    }
    return { body: result.value, mediaType: policy.mediaType, fileName: policy.originalName };
  }

  async upload(
    context: RequestContext,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    input: PolicyUploadInput,
    idempotencyKey: string,
  ) {
    this.requireAdministrator(context);
    const { store, jobs, storage, queue } = this.runtime();
    const tenantId = this.resolveTenant(context, input.tenantId);
    const domainPackId = input.domainPackId?.trim() || `pack_${tenantId}`;
    const domainPack = resolvePersistedDomainPackId(domainPackId);
    const installedPack = await store.getDomainPackDescriptor(tenantId, domainPackId);
    if (!installedPack) {
      throw new BadRequestException({
        code: 'DOMAIN_PACK_NOT_AVAILABLE_TO_TENANT',
        message: 'Choose a domain pack installed in the selected tenant workspace.',
      });
    }
    if (
      !domainPack.policyCollections.some(
        (collection) => collection.id === input.collectionId.trim(),
      )
    ) {
      throw new BadRequestException({
        code: 'POLICY_COLLECTION_NOT_FOUND',
        message: 'Choose a policy collection configured for this workspace.',
      });
    }
    const validation = await validateFile(
      file.buffer,
      file.mimetype,
      new DeterministicVirusScanner(
        file.buffer.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))
          ? 'infected'
          : 'clean',
      ),
      {
        maxBytes: 15 * 1024 * 1024,
        maxPages: 500,
        allowEncrypted: false,
        supportedMediaTypes: ['application/pdf'],
      },
    );
    if (!validation.accepted) {
      const issue = validation.issues[0]!;
      throw new BadRequestException({
        code: issue.quarantine ? 'POLICY_QUARANTINED' : issue.code.toUpperCase(),
        message: issue.message,
      });
    }
    const validFrom = parseDate(input.validFrom, 'validFrom');
    const validTo = input.validTo?.trim() ? parseDate(input.validTo, 'validTo') : null;
    if (validTo && validTo <= validFrom) {
      throw new BadRequestException({
        code: 'INVALID_VALIDITY_RANGE',
        message: 'The valid-to date must be after the valid-from date.',
      });
    }
    const policyId = stableId('policy', `${tenantId}:${idempotencyKey}`);
    const existing = await store.get(this.scopeForTenant(tenantId, context.userId), policyId);
    if (existing) return existing;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const storageKey = `${tenantId}/policies/${policyId}/${sha256}-${safeFileName(file.originalname)}`;
    const stored = await storage.put(storageKey, file.buffer, {
      tenant: tenantId,
      policy: policyId,
      sha256,
    });
    if (!stored.ok) {
      throw new ServiceUnavailableException({
        code: 'POLICY_STORAGE_UNAVAILABLE',
        message: stored.error.message,
      });
    }
    let policy;
    try {
      policy = await store.create({
        id: policyId,
        tenantId,
        domainPackId,
        title: input.title.trim(),
        policyVersion: input.policyVersion.trim(),
        collectionId: input.collectionId.trim(),
        storageKey,
        originalName: file.originalname,
        mediaType: 'application/pdf',
        sha256,
        byteSize: file.size,
        pageCount: validation.pageCount,
        language: input.language.trim() || 'und',
        validFrom: validFrom.toISOString(),
        validTo: validTo?.toISOString() ?? null,
        uploadedByUserId: context.userId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'POLICY_VERSION_EXISTS',
          message: 'This policy title and version already exists in the selected collection.',
        });
      }
      throw error;
    }
    const durableKey = `${tenantId}:${policyId}:process:${idempotencyKey}`;
    const job = await jobs.createJob({
      id: stableId('job', durableKey),
      tenantId,
      caseId: null,
      targetType: 'policy_version',
      targetId: policyId,
      enqueuedByUserId: context.userId,
      correlationId: context.correlationId,
      queueJobId: null,
      status: 'queued',
      progress: 0,
      attempts: 0,
      errorCode: null,
      kind: 'process_policy',
      idempotencyKey: durableKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const enqueued = await queue.enqueue(
      'process_policy',
      {
        databaseJobId: job.id,
        tenantId,
        targetType: 'policy_version',
        targetId: policyId,
        policyDocumentId: policyId,
        idempotencyKey: durableKey,
      },
      { idempotencyKey: job.id, maxAttempts: 3 },
    );
    if (!enqueued.ok) {
      await jobs.updateJob(job.id, tenantId, {
        status: 'failed',
        progress: 0,
        errorCode: 'QUEUE_UNAVAILABLE',
        eventType: 'job.failed',
        stage: 'queue',
        message: 'The policy could not be added to the processing queue.',
      });
      throw new ServiceUnavailableException({
        code: 'QUEUE_UNAVAILABLE',
        message: enqueued.error.message,
      });
    }
    await jobs.updateJob(job.id, tenantId, {
      status: 'queued',
      progress: 0,
      queueJobId: enqueued.value.jobId,
      eventType: enqueued.value.duplicate ? 'queue.duplicate_suppressed' : 'queue.enqueued',
      stage: 'queue',
      message: enqueued.value.duplicate
        ? 'This policy-processing request was already queued.'
        : 'Policy queued and waiting for a worker.',
      actorUserId: context.userId,
    });
    return { ...policy, jobId: job.id };
  }

  async reprocess(context: RequestContext, policyId: string, idempotencyKey: string) {
    this.requireAdministrator(context);
    const { store, jobs, queue } = this.runtime();
    const policy = await store.getDetail(this.scope(context), policyId);
    if (!policy)
      throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: 'Policy not found.' });
    if (['processing', 'active', 'superseded', 'revoked'].includes(policy.status)) {
      throw new ConflictException({
        code: 'POLICY_NOT_REPROCESSABLE',
        message: `A ${policy.status.replaceAll('_', ' ')} policy cannot be regenerated.`,
      });
    }
    if (policy.proposals.some((proposal) => ['approved', 'activated'].includes(proposal.status))) {
      throw new ConflictException({
        code: 'APPROVED_RULES_PRESERVED',
        message: 'This policy has approved rules and cannot be regenerated in place.',
      });
    }
    const durableKey = `${policy.tenantId}:${policy.id}:reprocess:${idempotencyKey}`;
    const job = await jobs.createJob({
      id: stableId('job', durableKey),
      tenantId: policy.tenantId,
      caseId: null,
      targetType: 'policy_version',
      targetId: policy.id,
      enqueuedByUserId: context.userId,
      correlationId: context.correlationId,
      queueJobId: null,
      status: 'queued',
      progress: 0,
      attempts: 0,
      errorCode: null,
      kind: 'process_policy',
      idempotencyKey: durableKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (job.status !== 'queued' || job.queueJobId) return { policyId: policy.id, jobId: job.id };

    const processing = await store.updateStatus({
      tenantId: policy.tenantId,
      id: policy.id,
      expectedVersion: policy.version,
      status: 'processing',
      processingError: null,
    });
    const enqueued = await queue.enqueue(
      'process_policy',
      {
        databaseJobId: job.id,
        tenantId: policy.tenantId,
        targetType: 'policy_version',
        targetId: policy.id,
        policyDocumentId: policy.id,
        idempotencyKey: durableKey,
      },
      { idempotencyKey: job.id, maxAttempts: 3 },
    );
    if (!enqueued.ok) {
      await store.updateStatus({
        tenantId: policy.tenantId,
        id: policy.id,
        expectedVersion: processing.version,
        status: policy.status,
        processingError: null,
      });
      await jobs.updateJob(job.id, policy.tenantId, {
        status: 'failed',
        progress: 0,
        errorCode: 'QUEUE_UNAVAILABLE',
        eventType: 'job.failed',
        stage: 'queue',
        message: 'The policy regeneration request could not be added to the queue.',
      });
      throw new ServiceUnavailableException({
        code: 'QUEUE_UNAVAILABLE',
        message: enqueued.error.message,
      });
    }
    await jobs.updateJob(job.id, policy.tenantId, {
      status: 'queued',
      progress: 0,
      queueJobId: enqueued.value.jobId,
      eventType: enqueued.value.duplicate ? 'queue.duplicate_suppressed' : 'queue.enqueued',
      stage: 'queue',
      message: enqueued.value.duplicate
        ? 'This policy regeneration request was already queued.'
        : 'Policy regeneration queued and waiting for a worker.',
      actorUserId: context.userId,
    });
    return { policyId: policy.id, jobId: job.id };
  }

  async reviewProposal(
    context: RequestContext,
    policyId: string,
    proposalId: string,
    input: {
      decision: 'approve' | 'reject';
      reason: string;
      version: number;
      severity?: 'info' | 'minor' | 'major' | 'critical';
    },
  ) {
    this.requireAdministrator(context);
    const store = this.runtime().store;
    const policy = await store.getDetail(this.scope(context), policyId);
    if (!policy)
      throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: 'Policy not found.' });
    const proposal = policy.proposals.find((candidate) => candidate.id === proposalId);
    if (!proposal)
      throw new NotFoundException({
        code: 'PROPOSAL_NOT_FOUND',
        message: 'Rule proposal not found.',
      });
    if (proposal.status === 'invalid' && input.decision === 'approve') {
      throw new BadRequestException({
        code: 'INVALID_RULE_PROPOSAL',
        message: 'A blocked proposal cannot be approved. Dismiss it or fix its validation issues.',
        issues: proposal.validationIssues,
      });
    }
    if (proposal.status === 'proposed') assertProposalTransition('proposed', 'under_review');
    else if (proposal.status !== 'under_review' && proposal.status !== 'invalid') {
      throw new ConflictException({
        code: 'INVALID_PROPOSAL_STATE',
        message: `A ${proposal.status} proposal cannot be reviewed.`,
      });
    }
    assertProposalTransition(
      proposal.status === 'invalid' ? 'invalid' : 'under_review',
      input.decision === 'approve' ? 'approved' : 'rejected',
    );
    if (input.decision === 'approve') {
      const domainPack = resolvePersistedDomainPackId(policy.domainPackId);
      const candidate = toGovernanceProposal(policy.id, {
        ...proposal,
        severity: input.severity ?? proposal.severity,
      });
      const result = validateRuleProposal(candidate, domainPack, {
        approverUserId: context.userId,
        allowSelfApproval: this.#allowSelfApproval,
      });
      if (!result.valid) {
        throw new BadRequestException({
          code: 'INVALID_RULE_PROPOSAL',
          message: 'The rule proposal cannot be approved until its validation issues are fixed.',
          issues: result.issues,
        });
      }
    }
    const selfApprovalDisclosure =
      input.decision === 'approve' &&
      proposal.proposedByUserId === context.userId &&
      this.#allowSelfApproval
        ? ' [Local test-profile mode: proposer self-approval was permitted and audited.]'
        : '';
    const severityDisclosure =
      input.severity && input.severity !== proposal.severity
        ? ` [Finding severity changed from ${proposal.severity} to ${input.severity}.]`
        : '';
    return store.reviewProposal({
      tenantId: policy.tenantId,
      policyDocumentId: policy.id,
      proposalId,
      expectedVersion: input.version,
      reviewerUserId: context.userId,
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      reason: `${input.reason.trim()}${severityDisclosure}${selfApprovalDisclosure}`,
      ...(input.severity ? { severity: input.severity } : {}),
    });
  }

  async activate(
    context: RequestContext,
    policyId: string,
    input: { version: number; priority: number },
  ) {
    this.requireAdministrator(context);
    const store = this.runtime().store;
    const policy = await store.getDetail(this.scope(context), policyId);
    if (!policy)
      throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: 'Policy not found.' });
    assertPolicyTransition(policy.status as 'approved', 'active');
    const approved = policy.proposals.filter((proposal) => proposal.status === 'approved');
    if (!approved.length) {
      throw new ConflictException({
        code: 'APPROVED_RULES_REQUIRED',
        message: 'Approve at least one valid rule proposal before activating this policy.',
      });
    }
    return store.activate({
      tenantId: policy.tenantId,
      policyDocumentId: policy.id,
      expectedVersion: input.version,
      approverUserId: context.userId,
      rules: approved.map((proposal) => ({
        id: stableId('policy_rule', `${policy.id}:${proposal.id}`),
        proposalId: proposal.id,
        ruleKey: stableRuleKey(policy.collectionId, proposal.title),
        priority: input.priority,
      })),
    });
  }

  private runtime() {
    if (!this.#store || !this.#jobs || !this.#storage || !this.#queue) {
      throw new ServiceUnavailableException({
        code: 'POLICY_LIBRARY_REQUIRES_PRODUCTION_LOCAL',
        message: 'Start the production-local profile to manage durable policies.',
      });
    }
    return { store: this.#store, jobs: this.#jobs, storage: this.#storage, queue: this.#queue };
  }

  private requireAdministrator(context: RequestContext): void {
    requireAdministrator(context);
  }

  private resolveTenant(context: RequestContext, requested?: string): string {
    if (!context.platformAdmin) return context.tenantId;
    if (!requested || !context.tenantIds.includes(requested)) {
      throw new BadRequestException({
        code: 'TENANT_REQUIRED',
        message: 'Platform administrators must choose a tenant for the policy.',
      });
    }
    return requested;
  }

  private scope(context: RequestContext): AccessScope {
    return {
      tenantIds: context.tenantIds,
      platformAdmin: context.platformAdmin,
      userId: context.userId,
    };
  }

  private scopeForTenant(tenantId: string, userId: string): AccessScope {
    return { tenantIds: [tenantId], platformAdmin: false, userId };
  }
}

function toGovernanceProposal(
  policyId: string,
  proposal: StoredPolicyProposalDetail,
): PolicyRuleProposal {
  return {
    id: proposal.id,
    title: proposal.title,
    description: proposal.description,
    severity: proposal.severity as PolicyRuleProposal['severity'],
    when: proposal.condition as PolicyRuleProposal['when'],
    policyTags: proposal.policyTags,
    citations: proposal.citations.map((citation) => ({
      policyVersionId: policyId,
      page: citation.page,
      quote: citation.quote,
      ...(citation.policyChunkId ? { chunkId: citation.policyChunkId } : {}),
    })),
    tests: proposal.tests.map((test) => ({
      kind: test.kind,
      name: test.name,
      input: test.input,
      expected: test.expected,
    })),
    extraction: {
      providerId: proposal.providerId,
      model: proposal.model,
      promptVersion: proposal.promptVersion,
      confidence: proposal.confidence,
    },
    proposedByUserId: proposal.proposedByUserId,
  };
}

function resolvePersistedDomainPackId(domainPackId: string) {
  const direct = resolvePersistedDomainPack(domainPackId);
  if (direct) return direct;
  const key = domainPackId.startsWith('pack_tenant_')
    ? domainPackId.replace(/^pack_tenant_/, '').replaceAll('_', '-')
    : domainPackId
        .replace(/^pack_/, '')
        .replace(/_\d+_\d+_\d+$/, '')
        .replaceAll('_', '-');
  const aliases: Record<string, string> = {
    demo: 'pharmacy-supplier',
    legal: 'commercial-contract-review',
    insurance: 'insurance-claims-assessment',
    manufacturing: 'supplier-quality-assurance',
  };
  const pack = resolvePersistedDomainPack(aliases[key] ?? key);
  if (!pack)
    throw new BadRequestException({
      code: 'DOMAIN_PACK_NOT_INSTALLED',
      message: 'The policy domain pack is not installed.',
    });
  return pack;
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException({
      code: 'INVALID_DATE',
      message: `${field} must be a valid date.`,
    });
  }
  return parsed;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function stableRuleKey(collectionId: string, title: string): string {
  const slug = `${collectionId}-${title}`.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, '-');
  return slug.replaceAll(/^-+|-+$/g, '').slice(0, 80) || `rule-${ulid().toLocaleLowerCase()}`;
}

function safeFileName(value: string): string {
  return (
    value
      .normalize('NFKC')
      .replaceAll(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 160) || 'policy.pdf'
  );
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}
