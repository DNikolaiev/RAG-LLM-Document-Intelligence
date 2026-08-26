CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS policy_search_chunks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  domain_id text NOT NULL,
  pack_version text NOT NULL,
  document_id text NOT NULL,
  document_version text NOT NULL,
  collection_id text NOT NULL,
  content text NOT NULL,
  embedding vector(1536) NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  revoked_at timestamptz,
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS policy_search_scope_idx ON policy_search_chunks(tenant_id, domain_id, pack_version, collection_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS policy_search_embedding_hnsw_idx ON policy_search_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS policy_search_content_fts_idx ON policy_search_chunks USING gin (search_vector);

-- Drizzle owns the table DDL represented in src/schema.ts. These indexes and
-- policies are kept as explicit SQL because they express PostgreSQL-specific
-- retrieval and tenant-isolation behavior.
CREATE INDEX IF NOT EXISTS policy_chunks_embedding_hnsw_idx
  ON policy_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS policy_chunks_content_fts_idx
  ON policy_chunks USING gin (to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS documents_active_idx
  ON documents (tenant_id, updated_at DESC)
  WHERE processing_status IN ('queued', 'processing', 'needs_review');
CREATE INDEX IF NOT EXISTS findings_unresolved_idx
  ON findings (tenant_id, case_id, severity)
  WHERE status = 'open';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'memberships','domain_packs','cases','documents','document_pages',
    'extraction_runs','evidence_spans','extracted_facts','policy_documents',
    'policy_chunks','policy_search_chunks','rule_runs','findings','decisions','jobs','audit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
      table_name
    );
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO caselens_runtime;
GRANT SELECT ON audit_events TO caselens_auditor;
