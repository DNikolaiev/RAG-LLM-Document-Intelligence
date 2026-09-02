import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ulid } from 'ulid';
import { loadConfig } from '@caselens/config';
import { TEST_PROFILES, TEST_TENANTS, resolveTestTenant } from '@caselens/contracts';
import { validateFile } from '@caselens/document-pipeline';
import {
  PostgresCaseStore,
  type AccessScope,
  type PersistedCaseProjection,
} from '@caselens/persistence';
import {
  BullMqQueueProvider,
  DeterministicVirusScanner,
  S3CompatibleStorageProvider,
} from '@caselens/providers';
import { createDemoCases, type CaseStatus, type DemoCase } from './demo-data.js';
import type { RequestContext } from './request-context.js';

@Injectable()
export class ProductionCasesService implements OnModuleInit, OnModuleDestroy {
  readonly #store: PostgresCaseStore;
  readonly #storage: S3CompatibleStorageProvider;
  readonly #queue: BullMqQueueProvider;

  constructor() {
    const config = loadConfig();
    const redis = new URL(config.REDIS_URL!);
    this.#store = new PostgresCaseStore(config.DATABASE_URL!);
    this.#storage = new S3CompatibleStorageProvider({
      id: 'local-minio',
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      accessKeyId: config.S3_ACCESS_KEY!,
      secretAccessKey: config.S3_SECRET_KEY!,
      forcePathStyle: true,
    });
    this.#queue = new BullMqQueueProvider({
      id: 'local-bullmq',
      queueName: config.QUEUE_NAME,
      connection: {
        host: redis.hostname,
        port: Number(redis.port || 6379),
        ...(redis.password ? { password: decodeURIComponent(redis.password) } : {}),
      },
    });
  }

  async onModuleInit(): Promise<void> {
    const seededCases = createDemoCases();
    await this.#store.seed(
      TEST_TENANTS,
      TEST_PROFILES.map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        email: profile.email,
        tenantIds: profile.tenantIds,
        role: profile.role,
      })),
      seededCases,
    );
    await this.materializeSeedDocuments(seededCases);
  }

  private async materializeSeedDocuments(cases: readonly DemoCase[]): Promise<void> {
    const fixtureByDocumentId: Readonly<Record<string, string>> = {
      doc_questionnaire: 'pharmacy-supplier/01_supplier_questionnaire.pdf',
      doc_register: 'pharmacy-supplier/02_commercial_register_extract.pdf',
      doc_iso: 'pharmacy-supplier/03_iso_13485_certificate.pdf',
      doc_insurance: 'pharmacy-supplier/04_insurance_certificate.pdf',
      doc_dpa: 'pharmacy-supplier/05_data_processing_agreement.pdf',
      doc_contract: 'pharmacy-supplier/06_supply_contract.pdf',
      doc_case_legal_001: 'legal-contract/01_nordstern_distribution_agreement.pdf',
      doc_case_legal_register: 'legal-contract/02_nordstern_commercial_register_extract.pdf',
      doc_case_legal_dpa: 'legal-contract/03_nordstern_data-processing-annex.pdf',
      doc_case_legal_authority: 'legal-contract/04_nordstern_signature_authority_confirmation.pdf',
      doc_case_insurance_001: 'insurance-claim/01_kronenberg_water_damage_claim.pdf',
      doc_case_insurance_estimate: 'insurance-claim/02_kronenberg_repair_estimate.pdf',
      doc_case_insurance_report: 'insurance-claim/03_kronenberg_contractor_report.pdf',
      doc_case_insurance_settlement: 'insurance-claim/04_kronenberg_settlement_instruction.pdf',
      doc_case_manufacturing_001: 'manufacturing-supplier/01_vektor_material_certificate.pdf',
      doc_case_manufacturing_specification:
        'manufacturing-supplier/02_vektor_purchase_specification.pdf',
      doc_case_manufacturing_pmi: 'manufacturing-supplier/03_vektor_pmi_inspection_report.pdf',
      doc_case_manufacturing_release: 'manufacturing-supplier/04_vektor_release_note.pdf',
    };

    for (const item of cases) {
      const existing = new Set(
        (
          await this.#store.listDocuments(
            { tenantIds: [item.tenantId], platformAdmin: true },
            item.id,
          )
        ).map((document) => document.id),
      );
      for (const document of item.documents) {
        const fixture = fixtureByDocumentId[document.id];
        if (!fixture || existing.has(document.id)) continue;
        const source = await readFile(
          new URL(`../../../fixtures/documents/${fixture}`, import.meta.url),
        );
        const sha256 = createHash('sha256').update(source).digest('hex');
        const originalName = document.fileName ?? fixture.split('/').at(-1)!;
        const storageKey = `${item.tenantId}/${item.id}/${document.id}/${sha256}-${safeFileName(originalName)}`;
        const stored = await this.#storage.put(storageKey, source, {
          tenant: item.tenantId,
          case: item.id,
          sha256,
          seed: 'true',
        });
        if (!stored.ok) throw new Error(stored.error.message);
        await this.#store.recordDocument({
          id: document.id,
          tenantId: item.tenantId,
          caseId: item.id,
          storageKey,
          originalName,
          mediaType: 'application/pdf',
          sha256,
          byteSize: source.byteLength,
          pageCount: document.pages,
          warning: 'Seeded local production evidence.',
          processingStatus: document.status === 'needs_review' ? 'needs_review' : 'ready',
        });
      }

      // Existing local volumes retain their case projection between image upgrades.
      // Add newly introduced fixture documents to that projection after materializing
      // them, so the dossier UI and the worker see the same evidence set.
      const persisted = await this.#store.get(
        { tenantIds: [item.tenantId], platformAdmin: true },
        item.id,
      );
      if (!persisted) continue;
      const persistedDocuments = persisted.documents as DemoCase['documents'];
      const additions = item.documents.filter(
        (document) => !persistedDocuments.some((candidate) => candidate.id === document.id),
      );
      if (!additions.length) continue;
      persisted.documents = [...persistedDocuments, ...additions];
      await this.#store.save(persisted, persisted.version);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.#store.close();
  }

  async health(): Promise<{ persistence: string; queue: string; storage: string }> {
    await this.#store.health();
    const [queue, storage] = await Promise.all([this.#queue.health(), this.#storage.health()]);
    if (!queue.ok) throw new Error(queue.error.message);
    if (!storage.ok) throw new Error(storage.error.message);
    return { persistence: 'ok', queue: 'ok', storage: 'ok' };
  }

  async create(
    context: RequestContext,
    input: { subjectName: string; domainPackId: string; reference?: string | undefined },
    idempotencyKey: string,
  ) {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    const timestamp = new Date().toISOString();
    const id = stableId('case', `${context.tenantId}:create:${idempotencyKey}`);
    const existing = await this.#store.get(this.scope(context), id);
    if (existing) return this.summary(existing);
    const item: PersistedCaseProjection = {
      id,
      tenantId: context.tenantId,
      reference: input.reference ?? `CASE-${ulid().slice(-8)}`,
      subjectName: input.subjectName,
      domain: input.domainPackId,
      domainPackVersion: '1.0.0',
      status: 'processing',
      recommendation: null,
      progress: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      assignedTo: context.userId,
      assignedUserId: context.userId,
      version: 1,
      documents: [],
      facts: [],
      findings: [],
      audit: [this.auditEvent(context, 'case.created', `Created with ${input.domainPackId}`)],
      decision: null,
    };
    const inserted = await this.#store.insert(item);
    if (inserted) return this.summary(item);
    const winner = await this.#store.get(this.scope(context), id);
    if (!winner)
      throw new ConflictException({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The case create request conflicted. Retry safely with the same key.',
      });
    return this.summary(winner);
  }

  async list(
    context: RequestContext | string,
    status?: CaseStatus,
    query?: string,
    cursor?: string,
    limit = 20,
  ) {
    const items = await this.#store.list(this.scope(context), {
      ...(status ? { status } : {}),
      ...(query ? { query } : {}),
    });
    const cursorIndex = cursor ? items.findIndex((item) => item.id === cursor) : -1;
    if (cursor && cursorIndex < 0) {
      throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'The cursor is invalid.' });
    }
    const start = cursor ? cursorIndex + 1 : 0;
    const page = items.slice(start, start + Math.min(100, Math.max(1, limit)));
    return {
      items: page.map((item) => this.summary(item)),
      nextCursor: start + page.length < items.length ? (page.at(-1)?.id ?? null) : null,
      total: items.length,
    };
  }

  async get(context: RequestContext | string, id: string): Promise<DemoCase> {
    const item = await this.#store.get(this.scope(context), id);
    if (!item) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Case not found.' });
    return structuredClone(item) as DemoCase;
  }

  async getDocumentContent(context: RequestContext, caseId: string, documentId: string) {
    const scope = this.scope(context);
    const item = await this.#store.get(scope, caseId);
    if (!item) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Case not found.' });
    const document = (await this.#store.listDocuments(scope, caseId)).find(
      (candidate) => candidate.id === documentId,
    );
    if (!document) {
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document not found.',
      });
    }
    const source = await this.#storage.get(document.storageKey);
    if (!source.ok) {
      if (source.error.code === 'not_found') {
        throw new NotFoundException({
          code: 'DOCUMENT_CONTENT_NOT_FOUND',
          message: 'The original document content is not available.',
        });
      }
      throw new ServiceUnavailableException({
        code: 'STORAGE_UNAVAILABLE',
        message: source.error.message,
      });
    }
    return {
      body: source.value,
      mediaType: document.mediaType,
      fileName: document.originalName,
    };
  }

  async correctFact(
    context: RequestContext,
    caseId: string,
    factId: string,
    input: { value: unknown; reason: string; version: number },
  ) {
    this.requireRole(context, ['reviewer', 'approver', 'admin']);
    const item = await this.mutable(context, caseId);
    const fact = (item.facts as DemoCase['facts']).find((candidate) => candidate.id === factId);
    if (!fact)
      throw new NotFoundException({ code: 'FACT_NOT_FOUND', message: 'Extracted fact not found.' });
    if (fact.version !== input.version) this.versionConflict(fact.version);
    fact.value = input.value as string | number | boolean | null;
    fact.reviewStatus = 'corrected';
    fact.correctionReason = input.reason;
    fact.version += 1;
    const priorVersion = item.version;
    this.touch(item, context, 'fact.corrected', `${fact.label}: ${input.reason}`);
    await this.save(item, priorVersion);
    return { ...structuredClone(fact), caseVersion: item.version };
  }

  async resolveFinding(
    context: RequestContext,
    caseId: string,
    findingId: string,
    input: { status: 'accepted' | 'dismissed' | 'resolved'; reason: string; version: number },
  ) {
    this.requireRole(context, ['reviewer', 'approver', 'admin']);
    const item = await this.mutable(context, caseId);
    const finding = (item.findings as DemoCase['findings']).find(
      (candidate) => candidate.id === findingId,
    );
    if (!finding)
      throw new NotFoundException({ code: 'FINDING_NOT_FOUND', message: 'Finding not found.' });
    if (finding.version !== input.version) this.versionConflict(finding.version);
    finding.status = input.status;
    finding.version += 1;
    const priorVersion = item.version;
    this.touch(
      item,
      context,
      'finding.updated',
      `${finding.title}: ${input.status} — ${input.reason}`,
    );
    await this.save(item, priorVersion);
    return { ...structuredClone(finding), caseVersion: item.version };
  }

  async process(context: RequestContext, caseId: string, idempotencyKey: string) {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    const item = await this.mutable(context, caseId);
    const timestamp = new Date().toISOString();
    const durableKey = `${context.tenantId}:${context.userId}:${caseId}:process:${idempotencyKey}`;
    const job = await this.#store.createJob({
      id: stableId('job', durableKey),
      tenantId: item.tenantId,
      caseId,
      targetType: 'case',
      targetId: caseId,
      enqueuedByUserId: context.userId,
      correlationId: context.correlationId,
      queueJobId: null,
      status: 'queued',
      progress: 0,
      attempts: 0,
      errorCode: null,
      kind: 'process_case',
      idempotencyKey: durableKey,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const enqueued = await this.#queue.enqueue(
      'process_case',
      { databaseJobId: job.id, tenantId: item.tenantId, caseId, idempotencyKey: durableKey },
      { idempotencyKey: job.id, maxAttempts: 3 },
    );
    if (!enqueued.ok) {
      await this.#store.updateJob(job.id, item.tenantId, {
        status: 'failed',
        progress: 0,
        errorCode: 'QUEUE_UNAVAILABLE',
        eventType: 'job.failed',
        stage: 'queue',
        message: 'The request could not be added to the processing queue.',
      });
      throw new ServiceUnavailableException({
        code: 'QUEUE_UNAVAILABLE',
        message: enqueued.error.message,
      });
    }
    await this.#store.updateJob(job.id, item.tenantId, {
      status: 'queued',
      progress: 0,
      queueJobId: enqueued.value.jobId,
      eventType: enqueued.value.duplicate ? 'queue.duplicate_suppressed' : 'queue.enqueued',
      stage: 'queue',
      message: enqueued.value.duplicate
        ? 'This request was already queued; the existing job will be used.'
        : 'Request queued and waiting for a worker.',
      actorUserId: context.userId,
    });
    if (!enqueued.value.duplicate) {
      const priorVersion = item.version;
      this.touch(item, context, 'processing.queued', `Processing job ${job.id} queued`);
      await this.save(item, priorVersion);
    }
    return job;
  }

  async uploadDocument(
    context: RequestContext,
    caseId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    idempotencyKey: string,
  ) {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    const item = await this.mutable(context, caseId);
    const scanner = new DeterministicVirusScanner(
      file.buffer.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))
        ? 'infected'
        : 'clean',
    );
    const validation = await validateFile(file.buffer, file.mimetype, scanner, {
      maxBytes: 15 * 1024 * 1024,
      maxPages: 250,
      allowEncrypted: false,
      supportedMediaTypes: ['application/pdf', 'text/plain'],
    });
    if (!validation.accepted) {
      const issue = validation.issues[0]!;
      throw new BadRequestException({
        code: issue.quarantine ? 'UPLOAD_QUARANTINED' : issue.code.toUpperCase(),
        message: issue.message,
      });
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const documents = item.documents as DemoCase['documents'];
    const existing = documents.find((document) => document.warning?.includes(sha256));
    if (existing) return structuredClone(existing);
    const documentId = stableId('doc', `${context.tenantId}:${caseId}:${idempotencyKey}`);
    const storageKey = `${context.tenantId}/${caseId}/${documentId}/${sha256}-${safeFileName(file.originalname)}`;
    const stored = await this.#storage.put(storageKey, file.buffer, {
      tenant: context.tenantId,
      case: caseId,
      sha256,
    });
    if (!stored.ok)
      throw new ServiceUnavailableException({
        code: 'STORAGE_UNAVAILABLE',
        message: stored.error.message,
      });
    const document: DemoCase['documents'][number] = {
      id: documentId,
      name: file.originalname.replace(/\.[^.]+$/, ''),
      type: 'unknown',
      status: 'needs_review',
      pages: validation.pageCount ?? 0,
      confidence: null,
      fileName: file.originalname,
      warning: `Awaiting classification; sha256:${sha256}`,
    };
    await this.#store.recordDocument({
      id: documentId,
      tenantId: context.tenantId,
      caseId,
      storageKey,
      originalName: file.originalname,
      mediaType: file.mimetype,
      sha256,
      byteSize: file.size,
      pageCount: validation.pageCount ?? 0,
      warning: document.warning!,
    });
    documents.push(document);
    const priorVersion = item.version;
    this.touch(item, context, 'document.uploaded', `${file.originalname} accepted for processing`);
    await this.save(item, priorVersion);
    return structuredClone(document);
  }

  async getJob(context: RequestContext | string, id: string) {
    const job = await this.#store.getJob(this.scope(context), id);
    if (!job) throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
    return job;
  }

  async listJobs(context: RequestContext, limit = 30) {
    const jobs = await this.#store.listJobs(this.scope(context), limit);
    const events = await this.#store.listJobEvents(this.scope(context), undefined, limit * 4);
    const latestByJob = new Map<string, (typeof events)[number]>();
    for (const event of events)
      if (!latestByJob.has(event.jobId)) latestByJob.set(event.jobId, event);
    return {
      items: jobs.map((job) => ({ ...job, latestEvent: latestByJob.get(job.id) ?? null })),
      nextCursor: null,
    };
  }

  async getJobEvents(context: RequestContext, id: string) {
    await this.getJob(context, id);
    return {
      items: await this.#store.listJobEvents(this.scope(context), id, 100),
      nextCursor: null,
    };
  }

  async markJobEventsRead(context: RequestContext, eventIds: readonly string[]) {
    await this.#store.markJobEventsRead(this.scope(context), eventIds);
    return { updated: eventIds.length };
  }

  async cancelJob(context: RequestContext, id: string) {
    const job = await this.#store.getJob(this.scope(context), id);
    if (!job) throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
    if (job.status !== 'queued') {
      throw new ConflictException({
        code: 'JOB_NOT_CANCELLABLE',
        message: 'Only a queued request can be cancelled.',
      });
    }
    await this.#store.updateJob(job.id, job.tenantId, {
      status: job.status,
      progress: job.progress,
      eventType: 'job.cancel_requested',
      stage: 'queue',
      message: 'Cancellation requested.',
      actorUserId: context.userId,
    });
    const removed = await this.#queue.cancel(job.queueJobId ?? job.id);
    if (!removed.ok) {
      throw new ConflictException({
        code: 'JOB_NOT_CANCELLABLE',
        message: 'The worker has already claimed this request.',
      });
    }
    await this.#store.updateJob(job.id, job.tenantId, {
      status: 'cancelled',
      progress: job.progress,
      eventType: 'job.cancelled',
      stage: 'queue',
      message: 'Request cancelled before processing began.',
      actorUserId: context.userId,
    });
    await this.#store.updateJob(job.id, job.tenantId, {
      status: 'cancelled',
      progress: job.progress,
      eventType: 'queue.record_removed',
      stage: 'queue',
      message: 'Queue record removed after cancellation.',
    });
    return this.#store.getJob(this.scope(context), id);
  }

  async retryJob(context: RequestContext, id: string) {
    const job = await this.#store.getJob(this.scope(context), id);
    if (!job) throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
    if (job.status !== 'failed') {
      throw new ConflictException({
        code: 'JOB_NOT_RETRYABLE',
        message: 'Only a failed request can be retried.',
      });
    }
    const retried = await this.#queue.retry(job.queueJobId ?? job.id);
    if (!retried.ok) {
      throw new ConflictException({
        code: 'JOB_NOT_RETRYABLE',
        message: 'The failed queue record is no longer available for retry.',
      });
    }
    await this.#store.updateJob(job.id, job.tenantId, {
      status: 'queued',
      progress: 0,
      errorCode: null,
      eventType: 'job.retry_scheduled',
      stage: 'queue',
      message: 'Retry scheduled and waiting for a worker.',
      actorUserId: context.userId,
    });
    return this.#store.getJob(this.scope(context), id);
  }

  async reEvaluate(context: RequestContext, caseId: string, idempotencyKey: string) {
    this.requireRole(context, ['reviewer', 'approver', 'admin']);
    const item = await this.mutable(context, caseId);
    const open = (item.findings as DemoCase['findings']).filter(
      (finding) => finding.status === 'open',
    );
    item.recommendation = open.some(
      (finding) => finding.severity === 'critical' || finding.severity === 'major',
    )
      ? 'request_information'
      : 'approve';
    item.status = 'needs_review';
    const priorVersion = item.version;
    this.touch(item, context, 'rules.re_evaluated', `Recommendation: ${item.recommendation}`);
    await this.save(item, priorVersion);
    return this.process(context, caseId, `rules:${idempotencyKey}`);
  }

  async decide(
    context: RequestContext,
    caseId: string,
    input: {
      outcome: 'approve' | 'reject' | 'request_information';
      reason: string;
      version: number;
    },
  ) {
    const item = await this.mutable(context, caseId);
    if (item.version !== input.version) this.versionConflict(item.version);
    const allowed =
      input.outcome === 'request_information'
        ? (['reviewer', 'approver', 'admin'] as const)
        : (['approver', 'admin'] as const);
    this.requireRole(context, allowed, 'An approver role is required to approve or reject.');
    const openMaterial = (item.findings as DemoCase['findings']).filter(
      (finding) => finding.status === 'open' && ['critical', 'major'].includes(finding.severity),
    );
    if (input.outcome === 'approve' && openMaterial.length) {
      throw new ConflictException({
        code: 'OPEN_MATERIAL_FINDINGS',
        message: `Resolve or dismiss all material findings before approval (${openMaterial.length} remain).`,
      });
    }
    item.decision = {
      outcome: input.outcome,
      reason: input.reason,
      decidedAt: new Date().toISOString(),
      actor: context.userId,
    };
    item.status =
      input.outcome === 'request_information'
        ? 'request_information'
        : input.outcome === 'approve'
          ? 'approved'
          : 'rejected';
    const priorVersion = item.version;
    this.touch(item, context, 'decision.recorded', `${input.outcome}: ${input.reason}`);
    await this.save(item, priorVersion);
    return { ...structuredClone(item.decision!), caseVersion: item.version };
  }

  async export(context: RequestContext, caseId: string) {
    const item = await this.get(context, caseId);
    return {
      schemaVersion: '1.0.0',
      exportedAt: new Date().toISOString(),
      case: item,
      provenance: { domainPack: `${item.domain}@${item.domainPackVersion}`, demoMode: false },
    };
  }

  private async mutable(context: RequestContext, id: string): Promise<PersistedCaseProjection> {
    const item = await this.#store.get(this.scope(context), id);
    if (!item) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Case not found.' });
    return item;
  }

  private async save(item: PersistedCaseProjection, expectedVersion: number): Promise<void> {
    try {
      await this.#store.save(item, expectedVersion);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('VERSION_CONFLICT:'))
        this.versionConflict(expectedVersion + 1);
      throw error;
    }
  }

  private scope(context: RequestContext | string): AccessScope {
    return typeof context === 'string'
      ? { tenantIds: [context], platformAdmin: false }
      : {
          tenantIds: context.tenantIds,
          platformAdmin: context.platformAdmin,
          userId: context.userId,
        };
  }

  private summary(item: PersistedCaseProjection) {
    return {
      id: item.id,
      tenantId: item.tenantId,
      tenantName: resolveTestTenant(item.tenantId)?.name ?? item.tenantId,
      reference: item.reference,
      subjectName: item.subjectName,
      domain: item.domain,
      status: item.status,
      recommendation: item.recommendation,
      progress: item.progress,
      documentCount: item.documents.length,
      updatedAt: item.updatedAt,
      dueAt: item.dueAt,
      assignedTo: item.assignedTo,
      findingCounts: (item.findings as DemoCase['findings'])
        .filter((finding) => finding.status === 'open')
        .reduce<Record<string, number>>((counts, finding) => {
          counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
          return counts;
        }, {}),
    };
  }

  private touch(
    item: PersistedCaseProjection,
    context: RequestContext,
    action: string,
    detail: string,
  ): void {
    item.version += 1;
    item.updatedAt = new Date().toISOString();
    (item.audit as DemoCase['audit']).push(this.auditEvent(context, action, detail));
  }

  private auditEvent(context: RequestContext, action: string, detail: string) {
    return {
      id: `audit_${ulid()}`,
      at: new Date().toISOString(),
      actor: context.userId,
      action,
      detail,
    };
  }

  private versionConflict(currentVersion: number): never {
    throw new ConflictException({
      code: 'VERSION_CONFLICT',
      message: `The record changed. Refresh and retry with version ${currentVersion}.`,
    });
  }

  private requireRole(
    context: RequestContext,
    allowed: readonly RequestContext['role'][],
    message = 'Your role is not allowed to perform this action.',
  ): void {
    if (!allowed.includes(context.role))
      throw new ForbiddenException({ code: 'ROLE_FORBIDDEN', message });
  }
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 26)}`;
}

function safeFileName(value: string): string {
  return (
    value
      .normalize('NFKC')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'document'
  );
}
