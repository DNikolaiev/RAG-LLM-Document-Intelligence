import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { loadConfig } from '@caselens/config';
import { validateFile } from '@caselens/document-pipeline';
import { DeterministicVirusScanner } from '@caselens/providers';
import type { RequestContext } from './request-context.js';
import { createDemoCases, type CaseStatus, type DemoCase } from './demo-data.js';
import { resolveTestProfile, resolveTestTenant } from '@caselens/contracts';
import {
  contractCaseSummaryFields,
  toContractCaseDetail,
  toContractDocument,
} from './case-contract.js';
import { validateIntakeFiles, type IntakeFile } from './intake-validation.js';
import { resolveTenant } from './tenant.js';

/** Identifies demo-mode extraction as the `ExtractedFactSchema.provider.id` for every fact this
 *  in-memory service returns - a plain, clearly-synthetic label, not a real model name, since no
 *  real extraction provider runs in demo mode. */
const DEMO_FACT_PROVIDER_ID = 'caselens-demo-seed';

export interface DemoJob {
  id: string;
  tenantId: string;
  caseId: string;
  targetType: 'case' | 'case_document' | 'policy_version';
  targetId: string;
  enqueuedByUserId: string;
  correlationId: string;
  queueJobId: string | null;
  status: string;
  progress: number;
  attempts: number;
  errorCode: string | null;
  kind: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class CasesService {
  private readonly cases = createDemoCases();
  private readonly idempotency = new Map<string, unknown>();
  private readonly documentContent = new Map<
    string,
    { body: Uint8Array; mediaType: string; fileName: string }
  >();
  private readonly jobs = new Map<string, DemoJob>();
  private readonly jobEvents = new Map<
    string,
    Array<{
      id: string;
      jobId: string;
      tenantId: string;
      recipientUserId: string;
      actorUserId: string | null;
      sequence: number;
      type: string;
      stage: string | null;
      status: string;
      progress: number;
      message: string;
      metadata: Record<string, unknown>;
      occurredAt: string;
      readAt: string | null;
    }>
  >();
  private readonly maxDocuments = loadConfig().WORKER_MAX_DOCUMENTS;

  create(
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
    const tenantId = resolveTenant(context, input.tenantId);
    const key = `${tenantId}:create:${idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    const id = `case_${ulid()}`;
    const item: DemoCase = {
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
      version: 1,
      documents: [],
      facts: [],
      findings: [],
      audit: [
        {
          id: `audit_${ulid()}`,
          at: timestamp,
          actor: context.userId,
          action: 'case.created',
          detail: `Created with ${input.domainPackId}`,
        },
      ],
      decision: null,
    };
    this.cases.push(item);
    const result = this.summary(item);
    this.idempotency.set(key, result);
    return result;
  }

  /**
   * `POST /v1/cases/intake`: one multipart request that creates a case from the documents that
   * justify it, rather than an empty case filled in afterwards. Order matters and is the whole
   * point of this method - resolve the tenant, validate every attached file, and only then create
   * the case, attach the documents, and queue processing. A file rejected on validation must not
   * leave a half-built case behind, so nothing here is written until `validateIntakeFiles` has
   * accepted the entire batch.
   *
   * Idempotent the same way `create` and `process` already are: the whole response is cached by
   * `${tenantId}:intake:${idempotencyKey}`, so a replay returns the original case, document ids,
   * and job id without attaching or queueing anything a second time - the cache hit short-circuits
   * before any of that code runs.
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
    const validated = await validateIntakeFiles(files, this.maxDocuments);

    const key = `${tenantId}:intake:${idempotencyKey}`;
    const existing = this.idempotency.get(key) as
      { caseId: string; reference: string; documentIds: string[]; jobIds: string[] } | undefined;
    if (existing) return existing;

    const domainPackId = input.domainPackId?.trim() || `pack_${tenantId}`;
    const timestamp = new Date().toISOString();
    const id = `case_${ulid()}`;
    const documents = validated.map(({ file, sha256, pageCount }) => ({
      id: `doc_${ulid()}`,
      name: file.originalname.replace(/\.[^.]+$/, ''),
      type: 'unknown',
      status: 'needs_review' as const,
      pages: pageCount,
      confidence: null,
      fileName: file.originalname,
      warning: `Awaiting classification; sha256:${sha256}`,
      mediaType: file.mimetype,
      byteSize: file.size,
      sha256,
      createdAt: timestamp,
    }));
    for (const [index, document] of documents.entries()) {
      const { file } = validated[index]!;
      this.documentContent.set(`${tenantId}:${id}:${document.id}`, {
        body: Uint8Array.from(file.buffer),
        mediaType: file.mimetype,
        fileName: file.originalname,
      });
    }
    const item: DemoCase = {
      id,
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
      version: 1,
      documents,
      facts: [],
      findings: [],
      audit: [
        {
          id: `audit_${ulid()}`,
          at: timestamp,
          actor: context.userId,
          action: 'case.created',
          detail: `Created with ${domainPackId} from ${documents.length} attached document(s)`,
        },
      ],
      decision: null,
    };
    this.cases.push(item);

    const job = this.process(context, id, idempotencyKey);
    const result = {
      caseId: item.id,
      reference: item.reference,
      documentIds: documents.map((document) => document.id),
      jobIds: [job.id],
    };
    this.idempotency.set(key, result);
    return result;
  }

  list(
    context: RequestContext | string,
    status?: CaseStatus,
    query?: string,
    cursor?: string,
    limit = 20,
  ) {
    const tenantIds = this.tenantIds(context);
    const normalized = query?.trim().toLocaleLowerCase();
    let filtered = this.cases.filter(
      (item) =>
        tenantIds.includes(item.tenantId) &&
        (!status || item.status === status) &&
        (!normalized ||
          `${item.subjectName} ${item.reference}`.toLocaleLowerCase().includes(normalized)),
    );
    filtered = filtered.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
    );
    const cursorIndex = cursor ? filtered.findIndex((item) => item.id === cursor) : -1;
    if (cursor && cursorIndex < 0) {
      throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'The cursor is invalid.' });
    }
    const start = cursor ? cursorIndex + 1 : 0;
    const page = filtered.slice(start, start + Math.min(100, Math.max(1, limit)));
    return {
      items: page.map((item) => this.summary(item)),
      nextCursor: start + page.length < filtered.length ? (page.at(-1)?.id ?? null) : null,
      total: filtered.length,
    };
  }

  get(context: RequestContext | string, id: string) {
    const tenantIds = this.tenantIds(context);
    const item = this.cases.find(
      (candidate) => candidate.id === id && tenantIds.includes(candidate.tenantId),
    );
    if (!item) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Case not found.' });
    const clone = structuredClone(item);
    return toContractCaseDetail(
      clone,
      clone.documents,
      clone.facts,
      clone.findings,
      clone.createdAt,
      DEMO_FACT_PROVIDER_ID,
    );
  }

  correctFact(
    context: RequestContext,
    caseId: string,
    factId: string,
    input: { value: unknown; reason: string; version: number },
  ) {
    this.requireRole(context, ['reviewer', 'approver', 'admin']);
    const item = this.mutable(context, caseId);
    const fact = item.facts.find((candidate) => candidate.id === factId);
    if (!fact)
      throw new NotFoundException({ code: 'FACT_NOT_FOUND', message: 'Extracted fact not found.' });
    if (fact.version !== input.version) this.versionConflict(fact.version);
    fact.value = input.value as string | number | boolean | null;
    fact.reviewStatus = 'corrected';
    fact.correctionReason = input.reason;
    fact.version += 1;
    this.touch(item, context, 'fact.corrected', `${fact.label}: ${input.reason}`);
    return { ...structuredClone(fact), caseVersion: item.version };
  }

  resolveFinding(
    context: RequestContext,
    caseId: string,
    findingId: string,
    input: { status: 'accepted' | 'dismissed' | 'resolved'; reason: string; version: number },
  ) {
    this.requireRole(context, ['reviewer', 'approver', 'admin']);
    const item = this.mutable(context, caseId);
    const finding = item.findings.find((candidate) => candidate.id === findingId);
    if (!finding)
      throw new NotFoundException({ code: 'FINDING_NOT_FOUND', message: 'Finding not found.' });
    if (finding.version !== input.version) this.versionConflict(finding.version);
    finding.status = input.status;
    finding.version += 1;
    this.touch(
      item,
      context,
      'finding.updated',
      `${finding.title}: ${input.status} — ${input.reason}`,
    );
    return { ...structuredClone(finding), caseVersion: item.version };
  }

  process(context: RequestContext, caseId: string, idempotencyKey: string): DemoJob {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    const key = `${context.tenantId}:${context.userId}:process:${caseId}:${idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) return existing as DemoJob;
    const item = this.mutable(context, caseId);
    const job = {
      id: `job_${ulid()}`,
      tenantId: context.tenantId,
      caseId,
      targetType: 'case' as const,
      targetId: caseId,
      enqueuedByUserId: context.userId,
      correlationId: context.correlationId,
      queueJobId: null,
      status: 'queued',
      progress: 0,
      attempts: 0,
      errorCode: null,
      kind: 'process_case',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.idempotency.set(key, job);
    this.jobs.set(job.id, job);
    this.appendDemoEvent(
      job,
      context.userId,
      'job.created',
      'intake',
      'Processing request created.',
    );
    this.appendDemoEvent(
      job,
      context.userId,
      'queue.enqueue_requested',
      'queue',
      'Sending the request to the processing queue.',
    );
    this.appendDemoEvent(job, context.userId, 'queue.enqueued', 'queue', 'Request queued.');
    this.touch(item, context, 'processing.queued', `Processing job ${job.id} queued`);
    return job;
  }

  /**
   * Demo-mode reprocess: idempotent per `(caseId, packVersion)` rather than a client-supplied
   * idempotency key, mirroring `ProductionCasesService.reprocess`. There is no persisted field
   * dictionary in demo mode, so "the current active pack version" is just the case's own
   * `domainPackVersion` field.
   */
  reprocess(context: RequestContext, caseId: string): { jobId: string } {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    const item = this.mutable(context, caseId);
    const key = `${context.tenantId}:reprocess:${caseId}:${item.domainPackVersion}`;
    const existing = this.idempotency.get(key);
    if (existing) return { jobId: (existing as DemoJob).id };
    const job = {
      id: `job_${ulid()}`,
      tenantId: context.tenantId,
      caseId,
      targetType: 'case' as const,
      targetId: caseId,
      enqueuedByUserId: context.userId,
      correlationId: context.correlationId,
      queueJobId: null,
      status: 'queued',
      progress: 0,
      attempts: 0,
      errorCode: null,
      kind: 'process_case',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.idempotency.set(key, job);
    this.jobs.set(job.id, job);
    this.appendDemoEvent(
      job,
      context.userId,
      'job.created',
      'intake',
      `Reprocessing request created against pack ${item.domainPackVersion}.`,
    );
    this.appendDemoEvent(
      job,
      context.userId,
      'queue.enqueue_requested',
      'queue',
      'Sending the reprocessing request to the processing queue.',
    );
    this.appendDemoEvent(job, context.userId, 'queue.enqueued', 'queue', 'Request queued.');
    this.touch(
      item,
      context,
      'processing.reprocess_queued',
      `Reprocessing job ${job.id} queued for pack ${item.domainPackVersion}`,
    );
    return { jobId: job.id };
  }

  async uploadDocument(
    context: RequestContext,
    caseId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    idempotencyKey: string,
  ) {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    const item = this.mutable(context, caseId);
    const key = `${context.tenantId}:upload:${caseId}:${idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) return existing;
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
      const code =
        issue.code === 'signature_mismatch' ||
        (issue.code === 'corrupt' &&
          file.mimetype === 'application/pdf' &&
          validation.detectedMediaType === null)
          ? 'MIME_SIGNATURE_MISMATCH'
          : issue.quarantine
            ? 'UPLOAD_QUARANTINED'
            : issue.code.toUpperCase();
      throw new BadRequestException({ code, message: issue.message });
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const duplicate = item.documents.find((document) => document.warning?.includes(sha256));
    const timestamp = new Date().toISOString();
    const document = {
      id: `doc_${ulid()}`,
      name: file.originalname.replace(/\.[^.]+$/, ''),
      type: 'unknown',
      status: 'needs_review' as const,
      pages: validation.pageCount ?? 0,
      confidence: null,
      fileName: file.originalname,
      warning: duplicate
        ? `Duplicate of ${duplicate.id}; sha256:${sha256}`
        : `Awaiting classification; sha256:${sha256}`,
      mediaType: file.mimetype,
      byteSize: file.size,
      sha256,
      createdAt: timestamp,
      ...(duplicate ? { duplicateOf: duplicate.id } : {}),
    };
    item.documents.push(document);
    this.documentContent.set(`${item.tenantId}:${caseId}:${document.id}`, {
      body: Uint8Array.from(file.buffer),
      mediaType: file.mimetype,
      fileName: file.originalname,
    });
    this.touch(item, context, 'document.uploaded', `${file.originalname} accepted for processing`);
    const responseDocument = toContractDocument(document, {
      tenantId: item.tenantId,
      caseId: item.id,
      createdAt: item.createdAt,
    });
    this.idempotency.set(key, responseDocument);
    return structuredClone(responseDocument);
  }

  getDocumentContent(context: RequestContext, caseId: string, documentId: string) {
    const item = this.get(context, caseId);
    const document = item.documents.find((candidate) => candidate.id === documentId);
    if (!document) {
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document not found.',
      });
    }
    const source = this.documentContent.get(`${item.tenantId}:${caseId}:${documentId}`);
    if (!source) {
      throw new NotFoundException({
        code: 'DOCUMENT_CONTENT_NOT_FOUND',
        message: 'The original document content is not available in this demo session.',
      });
    }
    return { ...source, body: Uint8Array.from(source.body) };
  }

  getJob(context: RequestContext | string, id: string) {
    const job = this.jobs.get(id);
    if (!job || !this.canSeeJob(context, job))
      throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
    return structuredClone(job);
  }

  listJobs(context: RequestContext, limit = 30) {
    const items = [...this.jobs.values()]
      .filter((job) => this.canSeeJob(context, job))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, Math.min(100, Math.max(1, limit)))
      .map((job) => {
        const item = this.cases.find((candidate) => candidate.id === job.caseId) ?? null;
        const targetName =
          job.targetType === 'case_document'
            ? (item?.documents.find((document) => document.id === job.targetId)?.fileName ?? null)
            : job.targetType === 'case'
              ? (item?.subjectName ?? null)
              : null;
        return {
          ...structuredClone(job),
          caseReference: item?.reference ?? null,
          caseSubjectName: item?.subjectName ?? null,
          targetName,
          enqueuedByName: resolveTestProfile(job.enqueuedByUserId).displayName,
          latestEvent: structuredClone(this.jobEvents.get(job.id)?.at(-1) ?? null),
        };
      });
    return { items, nextCursor: null };
  }

  getJobEvents(context: RequestContext, id: string) {
    this.getJob(context, id);
    return { items: structuredClone(this.jobEvents.get(id) ?? []), nextCursor: null };
  }

  markJobEventsRead(context: RequestContext, eventIds: readonly string[]) {
    if (context.platformAdmin) return { updated: 0 };
    let updated = 0;
    const timestamp = new Date().toISOString();
    for (const events of this.jobEvents.values()) {
      for (const event of events) {
        if (
          eventIds.includes(event.id) &&
          event.recipientUserId === context.userId &&
          event.readAt === null
        ) {
          event.readAt = timestamp;
          updated += 1;
        }
      }
    }
    return { updated };
  }

  cancelJob(context: RequestContext, id: string) {
    const job = this.jobs.get(id);
    if (!job || !this.canSeeJob(context, job)) {
      throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
    }
    if (job.status !== 'queued') {
      throw new ConflictException({
        code: 'JOB_NOT_CANCELLABLE',
        message: 'Only a queued request can be cancelled.',
      });
    }
    this.appendDemoEvent(
      job,
      context.userId,
      'job.cancel_requested',
      'queue',
      'Cancellation requested.',
    );
    job.status = 'cancelled';
    job.updatedAt = new Date().toISOString();
    this.appendDemoEvent(job, context.userId, 'job.cancelled', 'queue', 'Request cancelled.');
    this.appendDemoEvent(
      job,
      null,
      'queue.record_removed',
      'queue',
      'Queue record removed after cancellation.',
    );
    return structuredClone(job);
  }

  retryJob(context: RequestContext, id: string) {
    const job = this.jobs.get(id);
    if (!job || !this.canSeeJob(context, job)) {
      throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
    }
    if (job.status !== 'failed') {
      throw new ConflictException({
        code: 'JOB_NOT_RETRYABLE',
        message: 'Only a failed request can be retried.',
      });
    }
    job.status = 'queued';
    job.progress = 0;
    job.updatedAt = new Date().toISOString();
    this.appendDemoEvent(
      job,
      context.userId,
      'job.retry_scheduled',
      'queue',
      'Retry scheduled and waiting for a worker.',
    );
    return structuredClone(job);
  }

  reEvaluate(context: RequestContext, caseId: string, idempotencyKey: string) {
    this.requireRole(context, ['reviewer', 'approver', 'admin']);
    const item = this.mutable(context, caseId);
    const open = item.findings.filter((finding) => finding.status === 'open');
    item.recommendation = open.some(
      (finding) => finding.severity === 'critical' || finding.severity === 'major',
    )
      ? 'request_information'
      : 'approve';
    item.status = 'needs_review';
    this.touch(item, context, 'rules.re_evaluated', `Recommendation: ${item.recommendation}`);
    return this.process(context, caseId, `rules:${idempotencyKey}`);
  }

  decide(
    context: RequestContext,
    caseId: string,
    input: {
      outcome: 'approve' | 'reject' | 'request_information';
      reason: string;
      version: number;
    },
  ) {
    const item = this.mutable(context, caseId);
    if (item.version !== input.version) this.versionConflict(item.version);
    const allowedRoles =
      input.outcome === 'request_information'
        ? (['reviewer', 'approver', 'admin'] as const)
        : (['approver', 'admin'] as const);
    this.requireRole(context, allowedRoles, 'An approver role is required to approve or reject.');
    const openMaterialFindings = item.findings.filter(
      (finding) =>
        finding.status === 'open' &&
        (finding.severity === 'critical' || finding.severity === 'major'),
    );
    if (input.outcome === 'approve' && openMaterialFindings.length > 0) {
      throw new ConflictException({
        code: 'OPEN_MATERIAL_FINDINGS',
        message: `Resolve or dismiss all material findings before approval (${openMaterialFindings.length} remain).`,
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
    this.touch(item, context, 'decision.recorded', `${input.outcome}: ${input.reason}`);
    return { ...structuredClone(item.decision), caseVersion: item.version };
  }

  export(context: RequestContext, caseId: string) {
    const item = this.get(context, caseId);
    return {
      schemaVersion: '1.0.0',
      exportedAt: new Date().toISOString(),
      case: item,
      provenance: { domainPack: `pharmacy-supplier@${item.domainPackVersion}`, demoMode: true },
    };
  }

  private mutable(context: RequestContext | string, id: string): DemoCase {
    const tenantIds = this.tenantIds(context);
    const item = this.cases.find(
      (candidate) => candidate.id === id && tenantIds.includes(candidate.tenantId),
    );
    if (!item) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Case not found.' });
    return item;
  }

  private tenantIds(context: RequestContext | string): readonly string[] {
    return typeof context === 'string' ? [context] : context.tenantIds;
  }

  private summary(item: DemoCase) {
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
      findingCounts: item.findings
        .filter((finding) => finding.status === 'open')
        .reduce<Record<string, number>>((counts, finding) => {
          counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
          return counts;
        }, {}),
      ...contractCaseSummaryFields(
        item,
        item.findings.filter((finding) => finding.status === 'open').length,
      ),
    };
  }

  private touch(item: DemoCase, context: RequestContext, action: string, detail: string): void {
    item.version += 1;
    item.updatedAt = new Date().toISOString();
    item.audit.push({
      id: `audit_${ulid()}`,
      at: item.updatedAt,
      actor: context.userId,
      action,
      detail,
    });
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
    if (!allowed.includes(context.role)) {
      throw new ForbiddenException({ code: 'ROLE_FORBIDDEN', message });
    }
  }

  private canSeeJob(
    context: RequestContext | string,
    job: { tenantId: string; enqueuedByUserId: string },
  ): boolean {
    if (typeof context === 'string') return context === job.tenantId;
    return (
      context.platformAdmin ||
      (context.tenantIds.includes(job.tenantId) && context.userId === job.enqueuedByUserId)
    );
  }

  private appendDemoEvent(
    job: {
      id: string;
      tenantId: string;
      enqueuedByUserId: string;
      status: string;
      progress: number;
    },
    actorUserId: string | null,
    type: string,
    stage: string,
    message: string,
  ): void {
    const events = this.jobEvents.get(job.id) ?? [];
    const sequence = events.length + 1;
    events.push({
      id: `${job.id}:event:${sequence}`,
      jobId: job.id,
      tenantId: job.tenantId,
      recipientUserId: job.enqueuedByUserId,
      actorUserId,
      sequence,
      type,
      stage,
      status: job.status,
      progress: job.progress,
      message,
      metadata: {},
      occurredAt: new Date().toISOString(),
      readAt: null,
    });
    this.jobEvents.set(job.id, events);
  }
}
