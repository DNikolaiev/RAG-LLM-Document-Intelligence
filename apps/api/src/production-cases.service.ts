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
  PostgresPolicyStore,
  domainEventId,
  type AccessScope,
  type PendingDomainEvent,
  type PersistedCaseProjection,
} from '@caselens/persistence';
import {
  BullMqQueueProvider,
  DeterministicVirusScanner,
  S3CompatibleStorageProvider,
} from '@caselens/providers';
import {
  contractCaseSummaryFields,
  toContractCaseDetail,
  toContractDocument,
} from './case-contract.js';
import { createDemoCases, type CaseStatus, type DemoCase } from './demo-data.js';
import { validateIntakeFiles, type IntakeFile } from './intake-validation.js';
import type { RequestContext } from './request-context.js';
import { resolveTenant } from './tenant.js';

/** Identifies durable-mode extraction as the `ExtractedFactSchema.provider.id` for every fact
 *  this service returns - a plain, clearly-synthetic label, not a real model name, since neither
 *  the local production profile nor its seeded fixtures run a real extraction provider today. */
const DURABLE_FACT_PROVIDER_ID = 'caselens-production-local-seed';

@Injectable()
export class ProductionCasesService implements OnModuleInit, OnModuleDestroy {
  readonly #store: PostgresCaseStore;
  readonly #policies: PostgresPolicyStore;
  readonly #storage: S3CompatibleStorageProvider;
  readonly #queue: BullMqQueueProvider;
  readonly #maxDocuments: number;

  constructor() {
    const config = loadConfig();
    this.#maxDocuments = config.WORKER_MAX_DOCUMENTS;
    const redis = new URL(config.REDIS_URL!);
    this.#store = new PostgresCaseStore(config.DATABASE_URL!);
    this.#policies = new PostgresPolicyStore(config.DATABASE_URL!);
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
      // Hashed for every fixture-mapped document, not only ones not yet recorded in the SQL
      // `documents` table - `DocumentSchema.sha256`/`mediaType`/`byteSize` need a real value on
      // the *review-projection* copy of each document too (the one actually returned by
      // `get`/`list`, via `metadata.reviewProjection`), and an existing local volume upgraded
      // from an older image may already have the SQL row without ever having recorded those
      // fields on that projection - see the backfill below.
      const fixtureContentById = new Map<
        string,
        { sha256: string; byteSize: number; mediaType: string }
      >();
      for (const document of item.documents) {
        const fixture = fixtureByDocumentId[document.id];
        if (!fixture) continue;
        const source = await readFile(
          new URL(`../../../fixtures/documents/${fixture}`, import.meta.url),
        );
        const sha256 = createHash('sha256').update(source).digest('hex');
        fixtureContentById.set(document.id, {
          sha256,
          byteSize: source.byteLength,
          mediaType: 'application/pdf',
        });
        if (existing.has(document.id)) continue;
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
      // Backfill sha256/mediaType/byteSize onto an already-persisted document whose fixture
      // content was just hashed above but predates this field ever being recorded on the
      // projection (an existing local volume upgraded from an older image).
      let backfilled = false;
      const mergedDocuments = persistedDocuments.map((document) => {
        const content = fixtureContentById.get(document.id);
        if (!content || document.sha256) return document;
        backfilled = true;
        return { ...document, ...content };
      });
      if (!additions.length && !backfilled) continue;
      persisted.documents = [...mergedDocuments, ...additions];
      await this.#store.save(persisted, persisted.version);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.#store.close(), this.#policies.close()]);
  }

  /**
   * The outbox high-water mark, for measuring how far a read model has fallen behind.
   *
   * Platform administrators only. The number counts every fact the system has recorded across every
   * tenant, so handing it to a single-tenant reviewer would tell them how much work everybody else
   * is doing - the same reason the analytics read API scopes its counts. Lag is an operator's
   * question anyway.
   */
  async outboxState(context: RequestContext): Promise<{ lastRecordedSequence: number }> {
    if (!context.platformAdmin) {
      throw new ForbiddenException({
        code: 'ROLE_FORBIDDEN',
        message: 'Only a platform administrator can read the event backbone state.',
      });
    }
    return { lastRecordedSequence: await this.#store.outboxHighWaterMark() };
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
    input: {
      subjectName: string;
      domainPackId: string;
      reference?: string | undefined;
      tenantId?: string | undefined;
    },
    idempotencyKey: string,
  ) {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    // Same rule as `intake`: a tenant user is pinned to their own tenant, a platform administrator
    // must name one. Reading `context.tenantId` here silently filed a platform administrator's
    // case into whichever tenant happened to be first in their list.
    const tenantId = resolveTenant(context, input.tenantId);
    const timestamp = new Date().toISOString();
    const id = stableId('case', `${tenantId}:create:${idempotencyKey}`);
    const existing = await this.#store.get(this.scope(context), id);
    if (existing) return this.summary(existing);
    const item: PersistedCaseProjection = {
      id,
      tenantId,
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

  /**
   * `POST /v1/cases/intake`: one multipart request that creates a case from the documents that
   * justify it, rather than an empty case filled in afterwards (`create`, above, still exists for
   * other callers, but a platform administrator choosing a workspace is only offered here - the
   * one path the review console actually uses to create a case).
   *
   * Order matters and is the whole point of this method, mirroring the fix already applied to
   * `PoliciesService.upload`: resolve the tenant, validate EVERY attached file, and only then
   * create the case, attach the documents, and queue processing. Minting the case before every
   * file has passed validation - or checking the idempotency replay after a write has already
   * happened - reintroduces the exact defect that upload's collection-minting bug was: a rejected
   * file would orphan a half-built case, and a retry would either duplicate work or blow up on a
   * row it just created.
   *
   * Idempotent on `idempotencyKey` alone (scoped by tenant): the case id is a deterministic hash
   * of it, so a replay finds the case `store.insert` already made and returns immediately -
   * without attaching a single document or creating a job a second time. The job id returned on
   * that replay is *recomputed*, not re-fetched: `process`'s job id is a pure hash of
   * `processIdempotencyKey(...)`, so it can be reproduced here without touching the queue or the
   * jobs table again. (If a prior attempt crashed after the case and documents were saved but
   * before `process` ever ran, this recomputed id would name a job that was never actually
   * created - a known, narrow gap shared with `PoliciesService.upload`'s own replay path, and
   * recoverable the same way: the case's own `POST /v1/cases/:id/process` is itself idempotent
   * and can be called again.)
   */
  async intake(
    context: RequestContext,
    files: readonly IntakeFile[],
    input: {
      subjectName: string;
      domainPackId?: string | undefined;
      tenantId?: string | undefined;
    },
    idempotencyKey: string,
  ): Promise<{ caseId: string; reference: string; documentIds: string[]; jobIds: string[] }> {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    const tenantId = resolveTenant(context, input.tenantId);
    const validated = await validateIntakeFiles(files, this.#maxDocuments);

    const scope = this.scope(context);
    const caseId = stableId('case', `${tenantId}:intake:${idempotencyKey}`);
    const jobId = stableId('job', this.processIdempotencyKey(context, caseId, idempotencyKey));
    const existing = await this.#store.get(scope, caseId);
    if (existing) {
      return {
        caseId: existing.id,
        reference: existing.reference,
        documentIds: (existing.documents as DemoCase['documents']).map((document) => document.id),
        jobIds: [jobId],
      };
    }

    const domainPackId = input.domainPackId?.trim() || `pack_${tenantId}`;
    const timestamp = new Date().toISOString();
    const item: PersistedCaseProjection = {
      id: caseId,
      tenantId,
      reference: `CASE-${ulid().slice(-8)}`,
      subjectName: input.subjectName,
      domain: domainPackId,
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
      audit: [
        this.auditEvent(
          context,
          'case.created',
          `Created with ${domainPackId} from ${validated.length} attached document(s)`,
        ),
      ],
      decision: null,
    };
    const inserted = await this.#store.insert(item);
    if (!inserted) {
      // Raced by another request using the same idempotency key between our replay check above
      // and this insert - the same race `create` guards against.
      const winner = await this.#store.get(scope, caseId);
      if (!winner)
        throw new ConflictException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The case intake request conflicted. Retry safely with the same key.',
        });
      return {
        caseId: winner.id,
        reference: winner.reference,
        documentIds: (winner.documents as DemoCase['documents']).map((document) => document.id),
        jobIds: [jobId],
      };
    }

    const documents: DemoCase['documents'] = [];
    const priorVersion = item.version;
    for (const [index, { file, sha256, pageCount }] of validated.entries()) {
      const documentId = stableId('doc', `${tenantId}:${caseId}:intake:${idempotencyKey}:${index}`);
      const storageKey = `${tenantId}/${caseId}/${documentId}/${sha256}-${safeFileName(file.originalname)}`;
      // eslint-disable-next-line no-await-in-loop -- each document is its own storage write and
      // store record; nothing about them can be parallelized against `documents.push` order below.
      const stored = await this.#storage.put(storageKey, file.buffer, {
        tenant: tenantId,
        case: caseId,
        sha256,
      });
      if (!stored.ok) {
        throw new ServiceUnavailableException({
          code: 'STORAGE_UNAVAILABLE',
          message: stored.error.message,
        });
      }
      const warning = `Awaiting classification; sha256:${sha256}`;
      documents.push({
        id: documentId,
        name: file.originalname.replace(/\.[^.]+$/, ''),
        type: 'unknown',
        status: 'needs_review',
        pages: pageCount,
        confidence: null,
        fileName: file.originalname,
        warning,
        mediaType: file.mimetype,
        byteSize: file.size,
        sha256,
      });
      await this.#store.recordDocument({
        id: documentId,
        tenantId,
        caseId,
        storageKey,
        originalName: file.originalname,
        mediaType: file.mimetype,
        sha256,
        byteSize: file.size,
        pageCount,
        warning,
      });
      this.touch(
        item,
        context,
        'document.uploaded',
        `${file.originalname} accepted for processing`,
      );
    }
    item.documents = documents;
    await this.save(item, priorVersion);

    const job = await this.process(context, caseId, idempotencyKey);

    return {
      caseId: item.id,
      reference: item.reference,
      documentIds: documents.map((document) => document.id),
      jobIds: [job.id],
    };
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

  async get(context: RequestContext | string, id: string) {
    const item = await this.#store.get(this.scope(context), id);
    if (!item) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Case not found.' });
    const clone = structuredClone(item);
    return toContractCaseDetail(
      clone,
      clone.documents as DemoCase['documents'],
      clone.facts as DemoCase['facts'],
      clone.findings as DemoCase['findings'],
      clone.createdAt,
      DURABLE_FACT_PROVIDER_ID,
    );
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
    const durableKey = this.processIdempotencyKey(context, caseId, idempotencyKey);
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

  /**
   * Re-extracts one case against whatever pack version is active right now, typically after an
   * administrator approves a field proposal and widens the catalog. Idempotent per `(caseId,
   * packVersion)`: the durable job key is derived from those two alone, so requesting a reprocess
   * of the same case against the same active pack version twice returns the same job rather than
   * enqueueing a second one, and reprocessing again after a later approval mints a fresh job
   * because the pack version in the key has moved on.
   */
  async reprocess(context: RequestContext, caseId: string): Promise<{ jobId: string }> {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    const item = await this.mutable(context, caseId);
    const domainPackId = item.domainPackId ?? `pack_${item.tenantId}`;
    const pack = await this.#policies.getActivePackDefinition(item.tenantId, domainPackId);
    if (!pack) {
      throw new NotFoundException({
        code: 'DOMAIN_PACK_NOT_FOUND',
        message: 'No active domain pack is installed for this case.',
      });
    }
    const timestamp = new Date().toISOString();
    const durableKey = `${item.tenantId}:${caseId}:reprocess:${pack.version}`;
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
    if (job.status !== 'queued' || job.queueJobId) return { jobId: job.id };

    const enqueued = await this.#queue.enqueue(
      'process_case',
      {
        databaseJobId: job.id,
        tenantId: item.tenantId,
        caseId,
        domainPackVersion: pack.version,
        idempotencyKey: durableKey,
      },
      { idempotencyKey: job.id, maxAttempts: 3 },
    );
    if (!enqueued.ok) {
      await this.#store.updateJob(job.id, item.tenantId, {
        status: 'failed',
        progress: 0,
        errorCode: 'QUEUE_UNAVAILABLE',
        eventType: 'job.failed',
        stage: 'queue',
        message: 'The reprocessing request could not be added to the processing queue.',
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
        ? 'This reprocessing request was already queued; the existing job will be used.'
        : 'Case reprocessing queued and waiting for a worker.',
      actorUserId: context.userId,
    });
    if (!enqueued.value.duplicate) {
      const priorVersion = item.version;
      this.touch(
        item,
        context,
        'processing.reprocess_queued',
        `Reprocessing job ${job.id} queued for pack ${pack.version}`,
      );
      await this.save(item, priorVersion);
    }
    return { jobId: job.id };
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
    const duplicate = documents.find((document) => document.warning?.includes(sha256));
    if (duplicate) {
      return structuredClone(
        toContractDocument(duplicate, {
          tenantId: item.tenantId,
          caseId: item.id,
          createdAt: item.createdAt,
        }),
      );
    }
    // The case owns the tenant, not the caller. A platform administrator legitimately opens a case
    // in any of their tenants (`mutable` scopes by `context.tenantIds`), but their own
    // `context.tenantId` falls back to their first tenant - so deriving the storage prefix or the
    // document's tenant from the request would file another tenant's evidence under the wrong one.
    const caseTenantId = item.tenantId;
    const documentId = stableId('doc', `${caseTenantId}:${caseId}:${idempotencyKey}`);
    const storageKey = `${caseTenantId}/${caseId}/${documentId}/${sha256}-${safeFileName(file.originalname)}`;
    const stored = await this.#storage.put(storageKey, file.buffer, {
      tenant: caseTenantId,
      case: caseId,
      sha256,
    });
    if (!stored.ok)
      throw new ServiceUnavailableException({
        code: 'STORAGE_UNAVAILABLE',
        message: stored.error.message,
      });
    const timestamp = new Date().toISOString();
    const document: DemoCase['documents'][number] = {
      id: documentId,
      name: file.originalname.replace(/\.[^.]+$/, ''),
      type: 'unknown',
      status: 'needs_review',
      pages: validation.pageCount ?? 0,
      confidence: null,
      fileName: file.originalname,
      warning: `Awaiting classification; sha256:${sha256}`,
      mediaType: file.mimetype,
      byteSize: file.size,
      sha256,
      createdAt: timestamp,
    };
    await this.#store.recordDocument({
      id: documentId,
      tenantId: caseTenantId,
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
    return structuredClone(
      toContractDocument(document, {
        tenantId: item.tenantId,
        caseId: item.id,
        createdAt: item.createdAt,
      }),
    );
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
    // The fact travels with the change. `caseCreatedAt` rides along because a consumer that had
    // to ask this service when the case started would be coupled to it at read time - which is
    // the coupling the event exists to remove.
    await this.save(item, priorVersion, [
      {
        id: domainEventId(item.id, 'case.decided', String(item.version)),
        type: 'case.decided',
        aggregateType: 'case',
        aggregateId: item.id,
        occurredAt: item.updatedAt,
        payload: {
          reference: item.reference,
          outcome: input.outcome,
          decidedByUserId: context.userId,
          caseCreatedAt: item.createdAt,
        },
      },
    ]);
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

  /**
   * The durable job id `process` mints is a hash of this key alone, so `intake`'s idempotency
   * replay can recompute the same job id without a second store round trip - as long as it uses
   * this exact formula. Extracted so the two can never drift apart.
   */
  private processIdempotencyKey(
    context: RequestContext,
    caseId: string,
    idempotencyKey: string,
  ): string {
    return `${context.tenantId}:${context.userId}:${caseId}:process:${idempotencyKey}`;
  }

  private async save(
    item: PersistedCaseProjection,
    expectedVersion: number,
    events: readonly PendingDomainEvent[] = [],
  ): Promise<void> {
    try {
      await this.#store.save(item, expectedVersion, events);
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
      ...contractCaseSummaryFields(
        item,
        (item.findings as DemoCase['findings']).filter((finding) => finding.status === 'open')
          .length,
      ),
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
