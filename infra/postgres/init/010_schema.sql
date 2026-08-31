CREATE TABLE tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE users (
  id text PRIMARY KEY,
  external_subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE TABLE memberships (
  tenant_id text NOT NULL REFERENCES tenants(id), user_id text NOT NULL REFERENCES users(id), role text NOT NULL CHECK (role IN ('intake','reviewer','approver','auditor','admin')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);
CREATE TABLE domain_packs (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), domain_key text NOT NULL, semantic_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','active','retired')), definition jsonb NOT NULL, activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, domain_key, semantic_version)
);
CREATE INDEX domain_pack_tenant_status_idx ON domain_packs(tenant_id, status);
CREATE TABLE cases (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), domain_pack_id text NOT NULL REFERENCES domain_packs(id), reference text NOT NULL,
  subject_name text NOT NULL, status text NOT NULL, recommendation text, assigned_user_id text REFERENCES users(id), due_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, reference)
);
CREATE INDEX case_tenant_status_updated_idx ON cases(tenant_id, status, updated_at DESC);
CREATE INDEX case_assignee_idx ON cases(assigned_user_id);
CREATE TABLE documents (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), case_id text NOT NULL REFERENCES cases(id), storage_key text NOT NULL,
  original_name text NOT NULL, media_type text NOT NULL, sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), byte_size integer NOT NULL CHECK (byte_size >= 0),
  page_count integer CHECK (page_count >= 0), document_type text, processing_status text NOT NULL, duplicate_of_id text REFERENCES documents(id), warnings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE INDEX document_case_idx ON documents(case_id);
CREATE INDEX document_tenant_hash_idx ON documents(tenant_id, sha256);
CREATE INDEX documents_active_idx ON documents(tenant_id, updated_at DESC) WHERE processing_status IN ('queued','processing','needs_review');
CREATE TABLE document_pages (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), document_id text NOT NULL REFERENCES documents(id), page_number integer NOT NULL CHECK (page_number > 0),
  extraction_method text NOT NULL, language text, rotation_degrees integer NOT NULL DEFAULT 0, text text NOT NULL DEFAULT '', quality numeric(5,4) CHECK (quality BETWEEN 0 AND 1), metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(document_id, page_number)
);
CREATE INDEX document_page_tenant_document_idx ON document_pages(tenant_id, document_id);
CREATE TABLE extraction_runs (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), document_id text NOT NULL REFERENCES documents(id), provider text NOT NULL, model text NOT NULL,
  prompt_version text NOT NULL, schema_version text NOT NULL, status text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, usage jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX extraction_run_document_idx ON extraction_runs(document_id);
CREATE TABLE evidence_spans (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), document_id text NOT NULL REFERENCES documents(id), page_number integer NOT NULL CHECK (page_number > 0),
  quote text NOT NULL, bounding_box jsonb, start_offset integer, end_offset integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE INDEX evidence_document_page_idx ON evidence_spans(document_id, page_number);
CREATE TABLE extracted_facts (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), case_id text NOT NULL REFERENCES cases(id), extraction_run_id text NOT NULL REFERENCES extraction_runs(id),
  evidence_id text REFERENCES evidence_spans(id), field_path text NOT NULL, raw_value jsonb, normalized_value jsonb, confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  review_status text NOT NULL, corrected_by_user_id text REFERENCES users(id), correction_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  CHECK ((review_status <> 'corrected') OR (correction_reason IS NOT NULL AND length(correction_reason) >= 8))
);
CREATE INDEX fact_case_path_idx ON extracted_facts(case_id, field_path);
CREATE INDEX fact_evidence_idx ON extracted_facts(evidence_id);
CREATE TABLE policy_documents (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), domain_pack_id text NOT NULL REFERENCES domain_packs(id), title text NOT NULL, policy_version text NOT NULL,
  valid_from timestamptz NOT NULL, valid_to timestamptz, revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX policy_scope_validity_idx ON policy_documents(tenant_id, domain_pack_id, valid_from DESC);
CREATE TABLE policy_chunks (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), policy_document_id text NOT NULL REFERENCES policy_documents(id), ordinal integer NOT NULL,
  heading text, content text NOT NULL, embedding vector(768), metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(policy_document_id, ordinal)
);
CREATE INDEX policy_chunk_scope_idx ON policy_chunks(tenant_id, policy_document_id);
CREATE INDEX policy_chunks_embedding_hnsw_idx ON policy_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX policy_chunks_content_fts_idx ON policy_chunks USING gin (to_tsvector('simple', content));
CREATE TABLE policy_search_chunks (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), domain_id text NOT NULL, pack_version text NOT NULL,
  document_id text NOT NULL, document_version text NOT NULL, collection_id text NOT NULL, content text NOT NULL,
  embedding vector(768) NOT NULL, search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  valid_from timestamptz NOT NULL, valid_to timestamptz, revoked_at timestamptz, tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX policy_search_scope_idx ON policy_search_chunks(tenant_id, domain_id, pack_version, collection_id, valid_from DESC);
CREATE INDEX policy_search_embedding_hnsw_idx ON policy_search_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX policy_search_content_fts_idx ON policy_search_chunks USING gin (search_vector);
CREATE TABLE rule_runs (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), case_id text NOT NULL REFERENCES cases(id), domain_pack_id text NOT NULL REFERENCES domain_packs(id),
  status text NOT NULL, input_snapshot jsonb NOT NULL, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE INDEX rule_run_case_idx ON rule_runs(case_id, created_at DESC);
CREATE TABLE findings (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), case_id text NOT NULL REFERENCES cases(id), rule_run_id text NOT NULL REFERENCES rule_runs(id),
  evidence_id text REFERENCES evidence_spans(id), rule_key text NOT NULL, severity text NOT NULL CHECK (severity IN ('critical','major','minor')), status text NOT NULL,
  title text NOT NULL, description text NOT NULL, remediation text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE INDEX finding_case_severity_idx ON findings(case_id, severity);
CREATE INDEX findings_unresolved_idx ON findings(tenant_id, case_id, severity) WHERE status = 'open';
CREATE TABLE decisions (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), case_id text NOT NULL REFERENCES cases(id), outcome text NOT NULL, reason text NOT NULL,
  decided_by_user_id text NOT NULL REFERENCES users(id), decided_at timestamptz NOT NULL DEFAULT now(), supersedes_id text REFERENCES decisions(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE INDEX decision_case_time_idx ON decisions(case_id, decided_at DESC);
CREATE TABLE jobs (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), case_id text REFERENCES cases(id), target_type text NOT NULL, target_id text NOT NULL,
  enqueued_by_user_id text NOT NULL REFERENCES users(id),
  correlation_id text NOT NULL, queue_job_id text, kind text NOT NULL, status text NOT NULL,
  idempotency_key text NOT NULL, progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100), attempts integer NOT NULL DEFAULT 0, error jsonb, checkpoint jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id, idempotency_key)
);
CREATE INDEX job_tenant_status_updated_idx ON jobs(tenant_id, status, updated_at DESC);
CREATE INDEX job_case_idx ON jobs(case_id);
CREATE INDEX job_tenant_target_idx ON jobs(tenant_id, target_type, target_id);
CREATE INDEX job_enqueuer_updated_idx ON jobs(enqueued_by_user_id, updated_at DESC);
CREATE INDEX job_tenant_enqueuer_updated_idx ON jobs(tenant_id, enqueued_by_user_id, updated_at DESC);
CREATE TABLE job_events (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), job_id text NOT NULL REFERENCES jobs(id),
  recipient_user_id text NOT NULL REFERENCES users(id), actor_user_id text REFERENCES users(id), sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL, stage text, status text NOT NULL, progress integer NOT NULL CHECK (progress BETWEEN 0 AND 100),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 500), metadata jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
  UNIQUE(job_id, sequence)
);
CREATE INDEX job_event_tenant_recipient_time_idx ON job_events(tenant_id, recipient_user_id, occurred_at DESC);
CREATE INDEX job_event_job_time_idx ON job_events(job_id, occurred_at DESC);
CREATE TABLE workflow_checkpoints (
  tenant_id text NOT NULL REFERENCES tenants(id), checkpoint_key text NOT NULL, state jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, checkpoint_key)
);
CREATE INDEX workflow_checkpoint_updated_idx ON workflow_checkpoints(tenant_id, updated_at DESC);
CREATE TABLE audit_events (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), case_id text REFERENCES cases(id), actor_type text NOT NULL, actor_id text,
  action text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL, correlation_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_case_time_idx ON audit_events(case_id, occurred_at DESC);
CREATE INDEX audit_tenant_time_idx ON audit_events(tenant_id, occurred_at DESC);
