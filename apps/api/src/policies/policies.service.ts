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
  resolveCompiledDomainPack,
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
 * The two pack-versioning calls every governed pack mutation needs: read the tenant's active
 * definition, mint the next version. Field approval and collection creation both build on this
 * and nothing else, so a test can hand in a minimal in-memory stand-in rather than implementing
 * the whole `FieldDictionaryStore` surface (embedding search, fingerprint listing, proposal
 * batch-save) that neither one touches.
 */
export interface PackVersionStore {
  getActivePackDefinition(tenantId: string, domainPackId: string): Promise<DomainPack | null>;
  savePackVersion(input: SavePackVersionInput): Promise<{ semanticVersion: string }>;
}

/** `PackVersionStore` plus the two proposal-record calls approval and rejection need. */
export interface FieldProposalGovernanceStore extends PackVersionStore {
  getFieldProposal(tenantId: string, id: string): Promise<StoredFieldProposal | null>;
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

/**
 * Retrieval defaults for a collection an administrator creates at upload time, matching the
 * compiled pharmacy collections. Chunking is a retrieval-tuning concern, not a governance
 * decision, so the upload form never asks about it.
 */
export const NEW_POLICY_COLLECTION_CHUNK_SIZE = 700;
export const NEW_POLICY_COLLECTION_OVERLAP = 90;

/**
 * The collection id derived from an administrator-typed label: lowercased, every run of
 * non-alphanumeric characters folded to a single hyphen, leading and trailing hyphens trimmed.
 * Only shrinks or preserves length, so a label within the request-schema bound yields an id
 * within the same bound. Returns `''` for a label with no ASCII alphanumerics at all, which the
 * caller refuses rather than inventing an id for.
 */
export function toPolicyCollectionId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

/**
 * Builds the next pack definition with one collection appended, then re-validates the WHOLE pack
 * through `parseDomainPack` before anything is persisted - the same discipline
 * `applyFieldProposal` follows. Pure and synchronous: a blank name, a name that carries no
 * alphanumerics, or a slug the tenant already uses throws here, before a single byte is written,
 * so a refused name never leaves a partial pack behind.
 */
export function applyPolicyCollection(
  pack: DomainPack,
  label: string,
): { pack: DomainPack; collection: DomainPack['policyCollections'][number] } {
  const trimmed = label.trim();
  if (!trimmed) {
    throw new BadRequestException({
      code: 'POLICY_COLLECTION_NAME_REQUIRED',
      message: 'Name the new policy collection.',
    });
  }
  const id = toPolicyCollectionId(trimmed);
  if (!id) {
    throw new BadRequestException({
      code: 'POLICY_COLLECTION_NAME_INVALID',
      message: 'A collection name must contain at least one letter or digit.',
    });
  }
  if (pack.policyCollections.some((collection) => collection.id === id)) {
    throw new ConflictException({
      code: 'POLICY_COLLECTION_EXISTS',
      message: `The "${id}" collection already exists in this workspace. Choose it instead of creating it again.`,
    });
  }
  const collection = {
    id,
    label: trimmed,
    chunkSize: NEW_POLICY_COLLECTION_CHUNK_SIZE,
    overlap: NEW_POLICY_COLLECTION_OVERLAP,
  };
  const nextPack = { ...pack, policyCollections: [...pack.policyCollections, collection] };
  try {
    return { pack: parseDomainPack(nextPack), collection };
  } catch {
    throw new ConflictException({
      code: 'POLICY_COLLECTION_PACK_INVALID',
      message: 'Adding this collection would produce an invalid domain pack.',
    });
  }
}

/**
 * Creates one policy collection for a tenant and mints the next pack version for it.
 *
 * A collection name is typed by an administrator, not lifted out of an untrusted PDF the way a
 * field proposal is, so it needs no approval queue - but it is still a change to the governed
 * pack, so it is recorded the same auditable way field approval records one: a new version via
 * `savePackVersion`, never an in-place edit.
 */
export async function createPolicyCollection(
  store: PackVersionStore,
  context: RequestContext,
  tenantId: string,
  domainPackId: string,
  label: string,
): Promise<{ collectionId: string; semanticVersion: string; pack: DomainPack }> {
  requireAdministrator(context);
  // Persisted definition first, compiled catalog as the fallback - the same order every other
  // read in this service uses. A tenant that has never minted a version still has a compiled
  // pack, and refusing to add a collection to it would make this feature unusable on exactly
  // those tenants. Only when neither resolves is there genuinely no pack to extend.
  const activePack =
    (await store.getActivePackDefinition(tenantId, domainPackId)) ??
    resolveCompiledDomainPack(domainPackId);
  if (!activePack) {
    throw new NotFoundException({
      code: 'DOMAIN_PACK_NOT_FOUND',
      message: 'No active domain pack is installed for this tenant.',
    });
  }
  const { pack: nextDefinition, collection } = applyPolicyCollection(activePack, label);
  const semanticVersion = nextMinorVersion(activePack.version);
  let minted: { semanticVersion: string };
  try {
    minted = await store.savePackVersion({
      tenantId,
      domainPackId,
      definition: nextDefinition,
      semanticVersion,
      supersedes: activePack.version,
      actorUserId: context.userId,
    });
  } catch (error) {
    throw translateFieldDictionaryError(error);
  }
  return {
    collectionId: collection.id,
    semanticVersion: minted.semanticVersion,
    pack: { ...nextDefinition, version: minted.semanticVersion },
  };
}

/**
 * Resolves the collection one upload lands in, and is the only place that decides between the
 * two ways an administrator may name it. Exactly one of `collectionId` and `newCollectionLabel`
 * must be supplied.
 *
 * Sequencing matters and is deliberate: a named collection is minted FIRST, and the membership
 * check runs against the freshly minted definition, so the collection this returns is always one
 * the caller can go on to write a policy into. A failed mint throws here, before the upload has
 * stored bytes, created a policy row, or queued a job. The reverse is not symmetric and does not
 * need to be: if the upload later fails, the minted collection remains - an empty collection an
 * administrator can upload into or ignore, not a corrupt pack.
 *
 * Exported and taking an injected `PackVersionStore` for the same reason `approveFieldProposal`
 * is: `PoliciesService.runtime()` throws `POLICY_LIBRARY_REQUIRES_PRODUCTION_LOCAL` outside the
 * production-local profile, so no endpoint test can reach the upload path.
 */
export async function resolveUploadCollection(
  store: PackVersionStore,
  context: RequestContext,
  tenantId: string,
  domainPackId: string,
  input: { collectionId?: string | undefined; newCollectionLabel?: string | undefined },
): Promise<{ collectionId: string; pack: DomainPack; createdVersion: string | null }> {
  requireAdministrator(context);
  const collectionId = input.collectionId?.trim() ?? '';
  const newCollectionLabel = input.newCollectionLabel?.trim() ?? '';
  if (collectionId && newCollectionLabel) {
    throw new BadRequestException({
      code: 'POLICY_COLLECTION_AMBIGUOUS',
      message: 'Choose an existing policy collection or name a new one, not both.',
    });
  }
  if (!collectionId && !newCollectionLabel) {
    throw new BadRequestException({
      code: 'POLICY_COLLECTION_REQUIRED',
      message: 'Choose an existing policy collection or name a new one.',
    });
  }
  if (newCollectionLabel) {
    const created = await createPolicyCollection(
      store,
      context,
      tenantId,
      domainPackId,
      newCollectionLabel,
    );
    return {
      collectionId: created.collectionId,
      pack: created.pack,
      createdVersion: created.semanticVersion,
    };
  }
  const pack = await resolveActivePack(store, tenantId, domainPackId);
  if (!pack.policyCollections.some((collection) => collection.id === collectionId)) {
    throw new BadRequestException({
      code: 'POLICY_COLLECTION_NOT_FOUND',
      message: 'Choose a policy collection configured for this workspace.',
    });
  }
  return { collectionId, pack, createdVersion: null };
}

/**
 * Pack resolution order for every read in this service: the tenant's persisted, versioned
 * definition first, the compiled catalog as the fallback for a tenant that has never minted one.
 * Reading the compiled catalog alone would hide every minted collection and every approved
 * field, which is exactly the staleness the upload form used to suffer from.
 */
export async function resolveActivePack(
  store: PackVersionStore,
  tenantId: string,
  domainPackId: string,
): Promise<DomainPack> {
  const persisted = await store.getActivePackDefinition(tenantId, domainPackId);
  return persisted ?? resolvePersistedDomainPackId(domainPackId);
}

export interface PolicyUploadInput {
  tenantId?: string | undefined;
  title: string;
  policyVersion: string;
  /** An existing collection of the tenant's active pack. Mutually exclusive with the label below. */
  collectionId?: string | undefined;
  /** A collection to create for this tenant and upload into. See `resolveUploadCollection`. */
  newCollectionLabel?: string | undefined;
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
    const store = this.runtime().store;
    // The persisted definition first, so a collection an administrator minted at upload time and
    // a field the queue approved both show up here rather than only in the database.
    const [pack, activePolicies, activePolicyRules] = await Promise.all([
      resolveActivePack(store, tenantId, domainPackId),
      store.list(this.scopeForTenant(tenantId, context.userId), {
        domainPackId,
        status: 'active',
      }),
      store.listActiveRules(tenantId, domainPackId),
    ]);
    const documentTypes = new Map(
      pack.documentTypes.map((documentType) => [documentType.id, documentType]),
    );
    const registry = buildRuleRegistry(pack, activePolicies, activePolicyRules);

    return {
      tenantId,
      domainPack: {
        id: domainPackId,
        key: pack.id,
        name: pack.name,
        version: pack.version,
        terminology: pack.terminology,
        // Two different lists on purpose. `collections` is the registry's display grouping and
        // may carry the synthetic `general-controls` bucket; `uploadableCollections` is what the
        // pack actually declares, and is the only list `upload()` will accept a collection from.
        collections: registry.collections,
        uploadableCollections: pack.policyCollections.map((collection) => ({
          id: collection.id,
          label: collection.label,
        })),
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
    const installedPack = await store.getDomainPackDescriptor(tenantId, domainPackId);
    if (!installedPack) {
      throw new BadRequestException({
        code: 'DOMAIN_PACK_NOT_AVAILABLE_TO_TENANT',
        message: 'Choose a domain pack installed in the selected tenant workspace.',
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
    // Resolved - and, when the administrator named one, created - after every cheap check and
    // after the idempotency replay, but before any byte is stored or any job queued. Minting
    // earlier broke both ways: a rejected file orphaned a fresh collection, and replaying a
    // successful upload hit POLICY_COLLECTION_EXISTS instead of returning the stored policy.
    const collection = await resolveUploadCollection(store, context, tenantId, domainPackId, {
      ...(input.collectionId === undefined ? {} : { collectionId: input.collectionId }),
      ...(input.newCollectionLabel === undefined
        ? {}
        : { newCollectionLabel: input.newCollectionLabel }),
    });
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
        collectionId: collection.collectionId,
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
