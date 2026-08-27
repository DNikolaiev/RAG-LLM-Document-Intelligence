import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { validateFile } from '@caselens/document-pipeline';
import { DeterministicVirusScanner } from '@caselens/providers';
import type { RequestContext } from './request-context.js';
import { createDemoCases, type CaseStatus, type DemoCase } from './demo-data.js';
import { resolveTestTenant } from '@caselens/contracts';

@Injectable()
export class CasesService {
  private readonly cases = createDemoCases();
  private readonly idempotency = new Map<string, unknown>();
  private readonly jobs = new Map<
    string,
    {
      id: string;
      tenantId: string;
      caseId: string;
      status: string;
      progress: number;
      kind: string;
      createdAt: string;
    }
  >();

  create(
    context: RequestContext,
    input: { subjectName: string; domainPackId: string; reference?: string | undefined },
    idempotencyKey: string,
  ) {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    const key = `${context.tenantId}:create:${idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    const id = `case_${ulid()}`;
    const item: DemoCase = {
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

  get(context: RequestContext | string, id: string): DemoCase {
    const tenantIds = this.tenantIds(context);
    const item = this.cases.find(
      (candidate) => candidate.id === id && tenantIds.includes(candidate.tenantId),
    );
    if (!item) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Case not found.' });
    return structuredClone(item);
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

  process(context: RequestContext, caseId: string, idempotencyKey: string) {
    this.requireRole(context, ['intake', 'reviewer', 'admin']);
    const key = `${context.tenantId}:process:${caseId}:${idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) return existing;
    const item = this.mutable(context, caseId);
    const job = {
      id: `job_${ulid()}`,
      tenantId: context.tenantId,
      caseId,
      status: 'queued',
      progress: 0,
      kind: 'process_case',
      createdAt: new Date().toISOString(),
    };
    this.idempotency.set(key, job);
    this.jobs.set(job.id, job);
    this.touch(item, context, 'processing.queued', `Processing job ${job.id} queued`);
    return job;
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
    };
    item.documents.push(document);
    this.touch(item, context, 'document.uploaded', `${file.originalname} accepted for processing`);
    this.idempotency.set(key, document);
    return structuredClone(document);
  }

  getJob(context: RequestContext | string, id: string) {
    const job = this.jobs.get(id);
    if (!job || !this.tenantIds(context).includes(job.tenantId))
      throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
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
    return structuredClone(item.decision);
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
}
