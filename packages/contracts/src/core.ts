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

/**
 * `POST /v1/cases/intake` response: one multipart request that creates the case, attaches every
 * uploaded document, and queues processing. Plain (non-branded) string ids, like
 * `DomainPackConfigurationSchema` above - the running API mints case/document/job ids as
 * prefixed ulids or hashes (`case_...`, `doc_...`, `job_...`), not the bare-ulid shape
 * `CaseIdSchema`/`DocumentIdSchema`/`JobIdSchema` validate.
 */
export const CaseIntakeResponseSchema = z.object({
  caseId: z.string().min(1),
  reference: z.string().min(1),
  documentIds: z.array(z.string().min(1)),
  jobIds: z.array(z.string().min(1)),
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

export const JobStatusSchema = z.enum([
  'queued',
  'processing',
  'paused',
  'needs_review',
  'completed',
  'failed',
  'cancelled',
]);

export const JobEventTypeSchema = z.enum([
  'job.created',
  'queue.enqueue_requested',
  'queue.enqueued',
  'queue.duplicate_suppressed',
  'worker.claimed',
  'worker.started',
  'job.progress',
  'job.retry_scheduled',
  'job.completed',
  'job.failed',
  'job.cancel_requested',
  'job.cancelled',
  'queue.record_removed',
]);

export const JobLifecycleEventSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  tenantId: z.string().min(1),
  recipientUserId: z.string().min(1),
  actorUserId: z.string().min(1).nullable(),
  sequence: z.number().int().positive(),
  type: JobEventTypeSchema,
  stage: z.string().min(1).nullable(),
  status: JobStatusSchema,
  progress: z.number().int().min(0).max(100),
  message: z.string().min(1).max(500),
  metadata: z.record(z.string(), JsonValueSchema),
  occurredAt: IsoTimestampSchema,
  readAt: IsoTimestampSchema.nullable(),
});

export const JobNotificationSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  caseId: z.string().min(1).nullable(),
  targetType: z.enum(['case', 'case_document', 'policy_version']),
  targetId: z.string().min(1),
  enqueuedByUserId: z.string().min(1),
  kind: z.string().min(1),
  status: JobStatusSchema,
  progress: z.number().int().min(0).max(100),
  attempts: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  caseReference: z.string().min(1).nullable().optional(),
  caseSubjectName: z.string().min(1).nullable().optional(),
  targetName: z.string().min(1).nullable().optional(),
  enqueuedByName: z.string().min(1).nullable().optional(),
  latestEvent: JobLifecycleEventSchema.nullable(),
});

export const JobNotificationPageSchema = z.object({
  items: z.array(JobNotificationSchema),
  nextCursor: z.string().nullable(),
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

/**
 * The unified tenant rule registry returned by the domain-pack endpoint. Every active rule declares
 * the collection it belongs to and a discriminated origin: a domain-pack rule names its pack and
 * version, a policy-derived rule names its source policy document and that document's version.
 */
export const RuleOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('domain_pack'),
    domainPackName: z.string().min(1),
    domainPackVersion: z.string().min(1),
  }),
  z.object({
    kind: z.literal('policy_document'),
    policyId: z.string().min(1),
    policyTitle: z.string().min(1),
    policyVersion: z.string().min(1),
  }),
]);

export const RegistryCollectionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const RegistryRuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: SeveritySchema,
  collectionId: z.string().min(1),
  origin: RuleOriginSchema,
});

export const DomainPackRequiredDocumentSchema = z.object({
  id: z.string().min(1),
  documentType: z.string().min(1),
  documentLabel: z.string().min(1),
  severity: SeveritySchema,
  message: z.string().min(1),
  conditional: z.boolean(),
});

export const DomainPackFieldSchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean(),
  aliases: z.array(z.string()),
});

export const DomainPackDocumentTypeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  fields: z.array(DomainPackFieldSchema),
});

export const DomainPackConfigurationSchema = z.object({
  tenantId: z.string().min(1),
  domainPack: z.object({
    id: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    terminology: z.object({ case: z.string(), subject: z.string(), decision: z.string() }),
    /**
     * Display grouping for the rule registry. May contain the synthetic `general-controls`
     * collection, which exists only so domain-pack rules that declare no collection have
     * somewhere to be shown. Never offer these as upload targets.
     */
    collections: z.array(RegistryCollectionSchema),
    /**
     * The collections a policy may actually be uploaded into: the active pack's
     * `policyCollections`, verbatim. This is the list the upload form must be built from -
     * anything else can offer a collection the upload endpoint will refuse.
     */
    uploadableCollections: z.array(RegistryCollectionSchema),
    requiredDocuments: z.array(DomainPackRequiredDocumentSchema),
    documentTypes: z.array(DomainPackDocumentTypeSchema),
    rules: z.array(RegistryRuleSchema),
  }),
});

/**
 * A candidate extraction field proposed by an uploaded policy document, as returned to the
 * browser. Mirrors the `FieldProposal` interface in `@caselens/persistence`'s field dictionary
 * store, minus `embedding` — a 768-float vector never needs to reach the client. For
 * `kind: 'alias'`, `path` names the *existing* field and `aliases` carries only the new wording
 * proposed for it.
 */
export const FieldProposalCitationSchema = z.object({
  chunkId: z.string().min(1),
  page: z.number().int().positive(),
  quote: z.string().min(1),
});

export const FieldProposalDedupSchema = z.object({
  verdict: z.enum(['distinct', 'duplicate']),
  matchedPath: z.string().min(1).nullable(),
  similarity: z.number().min(0).max(1).nullable(),
  reason: z.string().min(1),
});

export const FieldProposalIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const FieldProposalSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  domainPackId: z.string().min(1),
  policyDocumentId: z.string().min(1),
  kind: z.enum(['new_field', 'alias']),
  documentTypeId: z.string().min(1),
  path: z.string().min(1),
  label: z.string().min(1),
  fieldType: z.enum(['string', 'number', 'boolean', 'date', 'currency', 'list']),
  aliases: z.array(z.string()),
  citation: FieldProposalCitationSchema,
  dedup: FieldProposalDedupSchema,
  status: z.enum(['proposed', 'invalid', 'approved', 'rejected']),
  issues: z.array(FieldProposalIssueSchema),
});

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
export type CaseIntakeResponse = z.infer<typeof CaseIntakeResponseSchema>;
export type Document = z.infer<typeof DocumentSchema>;
export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobEventType = z.infer<typeof JobEventTypeSchema>;
export type JobLifecycleEvent = z.infer<typeof JobLifecycleEventSchema>;
export type JobNotification = z.infer<typeof JobNotificationSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type ProblemDetail = z.infer<typeof ProblemDetailSchema>;
export type RuleOrigin = z.infer<typeof RuleOriginSchema>;
export type RegistryCollection = z.infer<typeof RegistryCollectionSchema>;
export type RegistryRule = z.infer<typeof RegistryRuleSchema>;
export type DomainPackConfiguration = z.infer<typeof DomainPackConfigurationSchema>;
export type FieldProposalCitation = z.infer<typeof FieldProposalCitationSchema>;
export type FieldProposalDedup = z.infer<typeof FieldProposalDedupSchema>;
export type FieldProposalIssue = z.infer<typeof FieldProposalIssueSchema>;
export type FieldProposal = z.infer<typeof FieldProposalSchema>;
