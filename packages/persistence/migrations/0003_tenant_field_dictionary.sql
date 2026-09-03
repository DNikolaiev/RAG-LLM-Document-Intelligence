-- Tenant field dictionary: versioned pack definitions plus cited, deduplicated field proposals.

CREATE EXTENSION IF NOT EXISTS vector;

-- Approving a proposal mints a new pack version and retires the previous one. The original
-- status check only allowed draft/active/retired, so widen it before any version is minted.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'domain_packs_status_check'
      AND conrelid = 'domain_packs'::regclass
  ) THEN
    ALTER TABLE domain_packs DROP CONSTRAINT domain_packs_status_check;
  END IF;
  ALTER TABLE domain_packs ADD CONSTRAINT domain_packs_status_check
    CHECK (status IN ('draft','active','retired','superseded'));
END $$;

CREATE INDEX IF NOT EXISTS domain_pack_tenant_key_activated_idx
  ON domain_packs(tenant_id, domain_key, activated_at DESC);

CREATE TABLE IF NOT EXISTS field_proposals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  domain_pack_id text NOT NULL REFERENCES domain_packs(id),
  policy_document_id text NOT NULL REFERENCES policy_documents(id),
  kind text NOT NULL CHECK (kind IN ('new_field','alias')),
  document_type_id text NOT NULL CHECK (document_type_id ~ '^[a-z][a-z0-9_]+$'),
  path text NOT NULL CHECK (path ~ '^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$'),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  field_type text NOT NULL CHECK (field_type IN ('string','number','boolean','date','currency','list')),
  aliases text[] NOT NULL DEFAULT '{}',
  citation_chunk_id text NOT NULL,
  citation_page integer NOT NULL CHECK (citation_page > 0),
  citation_quote text NOT NULL CHECK (length(btrim(citation_quote)) > 0),
  dedup_verdict text NOT NULL CHECK (dedup_verdict IN ('distinct','duplicate')),
  dedup_matched_path text,
  dedup_similarity numeric(5,4) CHECK (dedup_similarity IS NULL OR dedup_similarity BETWEEN 0 AND 1),
  dedup_reason text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','invalid','approved','rejected')),
  issues jsonb NOT NULL DEFAULT '[]',
  embedding vector(768) NOT NULL,
  reviewed_by_user_id text REFERENCES users(id),
  review_reason text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (dedup_verdict <> 'duplicate' OR dedup_matched_path IS NOT NULL),
  CHECK (kind <> 'alias' OR dedup_matched_path IS NOT NULL),
  CHECK (review_reason IS NULL OR length(btrim(review_reason)) > 0),
  CHECK ((status NOT IN ('approved','rejected')) OR
         (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS field_proposal_tenant_pack_status_idx
  ON field_proposals(tenant_id, domain_pack_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS field_proposal_document_idx
  ON field_proposals(policy_document_id);
CREATE INDEX IF NOT EXISTS field_proposal_tenant_pack_path_idx
  ON field_proposals(tenant_id, domain_pack_id, path);
CREATE INDEX IF NOT EXISTS field_proposal_reviewer_idx
  ON field_proposals(reviewed_by_user_id);
CREATE INDEX IF NOT EXISTS field_proposal_embedding_hnsw_idx
  ON field_proposals USING hnsw (embedding vector_cosine_ops);

ALTER TABLE field_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON field_proposals;
CREATE POLICY tenant_isolation ON field_proposals USING (
  tenant_id = current_setting('app.tenant_id', true)
  OR current_setting('app.platform_admin', true) = 'true'
) WITH CHECK (
  tenant_id = current_setting('app.tenant_id', true)
  OR current_setting('app.platform_admin', true) = 'true'
);

GRANT SELECT, INSERT, UPDATE ON field_proposals TO caselens_runtime;
