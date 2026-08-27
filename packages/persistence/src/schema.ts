import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const vector = customType<{ data: number[]; driverData: string }>({
  dataType(config: unknown) {
    const dimensions =
      typeof config === 'object' && config !== null && 'dimensions' in config
        ? Number(config.dimensions)
        : 768;
    return `vector(${dimensions})`;
  },
});

const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
};

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ...auditColumns,
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  externalSubject: text('external_subject').notNull().unique(),
  displayName: text('display_name').notNull(),
  email: text('email').notNull(),
  ...auditColumns,
});

export const memberships = pgTable(
  'memberships',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    ...auditColumns,
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    index('memberships_user_idx').on(table.userId),
  ],
);

export const domainPacks = pgTable(
  'domain_packs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    domainKey: text('domain_key').notNull(),
    semanticVersion: text('semantic_version').notNull(),
    status: text('status').notNull(),
    definition: jsonb('definition').notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('domain_pack_tenant_key_version_uq').on(
      table.tenantId,
      table.domainKey,
      table.semanticVersion,
    ),
    index('domain_pack_tenant_status_idx').on(table.tenantId, table.status),
  ],
);

export const cases = pgTable(
  'cases',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    domainPackId: text('domain_pack_id')
      .notNull()
      .references(() => domainPacks.id),
    reference: text('reference').notNull(),
    subjectName: text('subject_name').notNull(),
    status: text('status').notNull(),
    recommendation: text('recommendation'),
    assignedUserId: text('assigned_user_id').references(() => users.id),
    dueAt: timestamp('due_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('case_tenant_reference_uq').on(table.tenantId, table.reference),
    index('case_tenant_status_updated_idx').on(table.tenantId, table.status, table.updatedAt),
    index('case_assignee_idx').on(table.assignedUserId),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    storageKey: text('storage_key').notNull(),
    originalName: text('original_name').notNull(),
    mediaType: text('media_type').notNull(),
    sha256: text('sha256').notNull(),
    byteSize: integer('byte_size').notNull(),
    pageCount: integer('page_count'),
    documentType: text('document_type'),
    processingStatus: text('processing_status').notNull(),
    duplicateOfId: text('duplicate_of_id'),
    warnings: jsonb('warnings').notNull().default([]),
    ...auditColumns,
  },
  (table) => [
    index('document_case_idx').on(table.caseId),
    index('document_tenant_hash_idx').on(table.tenantId, table.sha256),
    index('document_active_processing_idx').on(table.tenantId, table.processingStatus),
  ],
);

export const documentPages = pgTable(
  'document_pages',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    pageNumber: integer('page_number').notNull(),
    extractionMethod: text('extraction_method').notNull(),
    language: text('language'),
    rotationDegrees: integer('rotation_degrees').notNull().default(0),
    text: text('text').notNull().default(''),
    quality: numeric('quality', { precision: 5, scale: 4 }),
    metadata: jsonb('metadata').notNull().default({}),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('document_page_number_uq').on(table.documentId, table.pageNumber),
    index('document_page_tenant_document_idx').on(table.tenantId, table.documentId),
  ],
);

export const extractionRuns = pgTable(
  'extraction_runs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    usage: jsonb('usage').notNull().default({}),
  },
  (table) => [index('extraction_run_document_idx').on(table.documentId)],
);

export const evidenceSpans = pgTable(
  'evidence_spans',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    pageNumber: integer('page_number').notNull(),
    quote: text('quote').notNull(),
    boundingBox: jsonb('bounding_box'),
    startOffset: integer('start_offset'),
    endOffset: integer('end_offset'),
    ...auditColumns,
  },
  (table) => [index('evidence_document_page_idx').on(table.documentId, table.pageNumber)],
);

export const extractedFacts = pgTable(
  'extracted_facts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    extractionRunId: text('extraction_run_id')
      .notNull()
      .references(() => extractionRuns.id),
    evidenceId: text('evidence_id').references(() => evidenceSpans.id),
    fieldPath: text('field_path').notNull(),
    rawValue: jsonb('raw_value'),
    normalizedValue: jsonb('normalized_value'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),
    reviewStatus: text('review_status').notNull(),
    correctedByUserId: text('corrected_by_user_id').references(() => users.id),
    correctionReason: text('correction_reason'),
    ...auditColumns,
  },
  (table) => [
    index('fact_case_path_idx').on(table.caseId, table.fieldPath),
    index('fact_evidence_idx').on(table.evidenceId),
  ],
);

export const policyDocuments = pgTable(
  'policy_documents',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    domainPackId: text('domain_pack_id')
      .notNull()
      .references(() => domainPacks.id),
    title: text('title').notNull(),
    policyVersion: text('policy_version').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    revoked: boolean('revoked').notNull().default(false),
    ...auditColumns,
  },
  (table) => [
    index('policy_scope_validity_idx').on(table.tenantId, table.domainPackId, table.validFrom),
  ],
);

export const policyChunks = pgTable(
  'policy_chunks',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    policyDocumentId: text('policy_document_id')
      .notNull()
      .references(() => policyDocuments.id),
    ordinal: integer('ordinal').notNull(),
    heading: text('heading'),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 768 }),
    metadata: jsonb('metadata').notNull().default({}),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('policy_chunk_ordinal_uq').on(table.policyDocumentId, table.ordinal),
    index('policy_chunk_scope_idx').on(table.tenantId, table.policyDocumentId),
  ],
);

export const ruleRuns = pgTable(
  'rule_runs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    domainPackId: text('domain_pack_id')
      .notNull()
      .references(() => domainPacks.id),
    status: text('status').notNull(),
    inputSnapshot: jsonb('input_snapshot').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [index('rule_run_case_idx').on(table.caseId, table.createdAt)],
);

export const findings = pgTable(
  'findings',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    ruleRunId: text('rule_run_id')
      .notNull()
      .references(() => ruleRuns.id),
    evidenceId: text('evidence_id').references(() => evidenceSpans.id),
    ruleKey: text('rule_key').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    remediation: text('remediation'),
    ...auditColumns,
  },
  (table) => [
    index('finding_case_severity_idx').on(table.caseId, table.severity),
    index('finding_tenant_status_idx').on(table.tenantId, table.status),
  ],
);

export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    outcome: text('outcome').notNull(),
    reason: text('reason').notNull(),
    decidedByUserId: text('decided_by_user_id')
      .notNull()
      .references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    supersedesId: text('supersedes_id'),
    ...auditColumns,
  },
  (table) => [index('decision_case_time_idx').on(table.caseId, table.decidedAt)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    caseId: text('case_id').references(() => cases.id),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    progress: integer('progress').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    error: jsonb('error'),
    checkpoint: jsonb('checkpoint').notNull().default({}),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('job_tenant_idempotency_uq').on(table.tenantId, table.idempotencyKey),
    index('job_case_idx').on(table.caseId),
    index('job_tenant_status_updated_idx').on(table.tenantId, table.status, table.updatedAt),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    caseId: text('case_id').references(() => cases.id),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    correlationId: text('correlation_id').notNull(),
    details: jsonb('details').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_case_time_idx').on(table.caseId, table.occurredAt),
    index('audit_tenant_time_idx').on(table.tenantId, table.occurredAt),
  ],
);

export const workflowCheckpoints = pgTable(
  'workflow_checkpoints',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    checkpointKey: text('checkpoint_key').notNull(),
    state: jsonb('state').notNull(),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.checkpointKey] }),
    index('workflow_checkpoint_updated_idx').on(table.tenantId, table.updatedAt),
  ],
);
