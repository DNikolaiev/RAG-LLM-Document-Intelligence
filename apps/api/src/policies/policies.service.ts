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
import { validateFile } from '@caselens/document-pipeline';
import {
  assertPolicyTransition,
  assertProposalTransition,
  resolvePersistedDomainPack,
  validateRuleProposal,
  type PolicyRuleProposal,
} from '@caselens/domain';
import {
  PostgresCaseStore,
  PostgresPolicyStore,
  type AccessScope,
  type StoredPolicyProposalDetail,
} from '@caselens/persistence';
import {
  BullMqQueueProvider,
  DeterministicVirusScanner,
  S3CompatibleStorageProvider,
} from '@caselens/providers';
import type { RequestContext } from '../request-context.js';

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

  async reviewProposal(
    context: RequestContext,
    policyId: string,
    proposalId: string,
    input: { decision: 'approve' | 'reject'; reason: string; version: number },
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
      const candidate = toGovernanceProposal(policy.id, proposal);
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
    return store.reviewProposal({
      tenantId: policy.tenantId,
      policyDocumentId: policy.id,
      proposalId,
      expectedVersion: input.version,
      reviewerUserId: context.userId,
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      reason: `${input.reason.trim()}${selfApprovalDisclosure}`,
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
    if (context.role !== 'admin') {
      throw new ForbiddenException({
        code: 'POLICY_ADMIN_REQUIRED',
        message: 'Only tenant or platform administrators can manage policies.',
      });
    }
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
