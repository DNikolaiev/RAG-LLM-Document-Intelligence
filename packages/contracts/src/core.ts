import { z } from 'zod';
import {
  AuditEventIdSchema,
  CaseIdSchema,
  DocumentIdSchema,
  EvidenceIdSchema,
  FactIdSchema,
  FindingIdSchema,
  JobIdSchema,
  TenantIdSchema,
  UserIdSchema,
} from './ids.js';

export const IsoTimestampSchema = z.string().datetime({ offset: true });
export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const CaseStatusSchema = z.enum([
  'intake',
  'processing',
  'needs_review',
  'ready_for_decision',
  'completed',
  'cancelled',
  'failed',
]);

export const DecisionSchema = z.enum(['approve', 'request_information', 'reject', 'manual_review']);

export const SeveritySchema = z.enum(['info', 'minor', 'major', 'critical']);
export const FindingStatusSchema = z.enum(['open', 'accepted', 'dismissed', 'resolved']);
export const DocumentStatusSchema = z.enum([
  'received',
  'quarantined',
  'validated',
  'processing',
  'processed',
  'needs_review',
  'failed',
]);

export const BoundingBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
});

export const EvidenceSpanSchema = z.object({
  id: EvidenceIdSchema,
  tenantId: TenantIdSchema,
  documentId: DocumentIdSchema,
  page: z.number().int().positive(),
  quote: z.string().min(1).max(2_000),
  boundingBox: BoundingBoxSchema.optional(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().positive().optional(),
  source: z.enum(['native_text', 'ocr', 'human']),
  confidence: z.number().min(0).max(1),
});

export const ExtractedFactSchema = z.object({
  id: FactIdSchema,
  tenantId: TenantIdSchema,
  caseId: CaseIdSchema,
  path: z.string().min(1),
  rawValue: JsonValueSchema,
  normalizedValue: JsonValueSchema,
  valueType: z.enum(['string', 'number', 'boolean', 'date', 'currency', 'list', 'object']),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(EvidenceIdSchema),
  sourceDocumentIds: z.array(DocumentIdSchema).min(1),
  status: z.enum(['extracted', 'confirmed', 'corrected', 'conflicting']),
  provider: z.object({
    id: z.string().min(1),
    model: z.string().optional(),
    version: z.string().optional(),
  }),
  createdAt: IsoTimestampSchema,
});

export const FindingSchema = z.object({
  id: FindingIdSchema,
  tenantId: TenantIdSchema,
  caseId: CaseIdSchema,
  ruleId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: SeveritySchema,
  status: FindingStatusSchema,
  evidenceIds: z.array(EvidenceIdSchema),
  policyChunkIds: z.array(z.string()),
  deterministic: z.boolean(),
  createdAt: IsoTimestampSchema,
});

export const DocumentSchema = z.object({
  id: DocumentIdSchema,
  tenantId: TenantIdSchema,
  caseId: CaseIdSchema,
  fileName: z.string().min(1),
  mediaType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: DocumentStatusSchema,
  classification: z.string().nullable(),
  classificationConfidence: z.number().min(0).max(1).nullable(),
  duplicateOf: DocumentIdSchema.nullable(),
  versionOf: DocumentIdSchema.nullable(),
  warnings: z.array(z.string()),
  createdAt: IsoTimestampSchema,
});

export const CaseSummarySchema = z.object({
  id: CaseIdSchema,
  tenantId: TenantIdSchema,
  reference: z.string().min(1),
  title: z.string().min(1),
  domainPackId: z.string().min(1),
  domainPackVersion: z.string().min(1),
  status: CaseStatusSchema,
  recommendation: DecisionSchema.nullable(),
  openFindings: z.number().int().nonnegative(),
  updatedAt: IsoTimestampSchema,
  version: z.number().int().positive(),
});

export const CaseDetailSchema = CaseSummarySchema.extend({
  documents: z.array(DocumentSchema),
  facts: z.array(ExtractedFactSchema),
  findings: z.array(FindingSchema),
});

export const JobSchema = z.object({
  id: JobIdSchema,
  tenantId: TenantIdSchema,
  caseId: CaseIdSchema,
  type: z.string().min(1),
  state: z.enum(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  progress: z.number().min(0).max(100),
  attempt: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  errorCode: z.string().nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export const AuditEventSchema = z.object({
  id: AuditEventIdSchema,
  tenantId: TenantIdSchema,
  caseId: CaseIdSchema,
  actorId: UserIdSchema.nullable(),
  type: z.string().min(1),
  at: IsoTimestampSchema,
  correlationId: z.string().min(1),
  payload: z.record(z.string(), JsonValueSchema),
});

export const CursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const ProblemDetailSchema = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  code: z.string(),
  correlationId: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type Decision = z.infer<typeof DecisionSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type CaseSummary = z.infer<typeof CaseSummarySchema>;
export type CaseDetail = z.infer<typeof CaseDetailSchema>;
export type Document = z.infer<typeof DocumentSchema>;
export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Job = z.infer<typeof JobSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type ProblemDetail = z.infer<typeof ProblemDetailSchema>;
