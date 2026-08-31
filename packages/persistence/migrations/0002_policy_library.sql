-- Canonical policy-library metadata, cited AI proposals, deterministic tests, and approved rules.

ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS collection_id text;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS original_name text;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS media_type text;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS byte_size integer;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS page_count integer;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS uploaded_by_user_id text REFERENCES users(id);
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS approved_by_user_id text REFERENCES users(id);
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS processing_error jsonb;
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS extraction_metadata jsonb;

UPDATE policy_documents
SET collection_id = coalesce(collection_id, 'general'),
    storage_key = coalesce(storage_key, 'legacy/' || id),
    original_name = coalesce(original_name, title || '.pdf'),
    media_type = coalesce(media_type, 'application/pdf'),
    sha256 = coalesce(sha256, repeat('0', 64)),
    byte_size = coalesce(byte_size, 0),
    language = coalesce(language, 'und'),
    status = coalesce(status, CASE WHEN revoked THEN 'revoked' ELSE 'active' END),
    extraction_metadata = coalesce(extraction_metadata, '{}'::jsonb);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM policy_documents WHERE uploaded_by_user_id IS NULL) THEN
    RAISE EXCEPTION 'Backfill policy_documents.uploaded_by_user_id before applying policy governance';
  END IF;
END $$;

ALTER TABLE policy_documents ALTER COLUMN collection_id SET NOT NULL;
ALTER TABLE policy_documents ALTER COLUMN storage_key SET NOT NULL;
ALTER TABLE policy_documents ALTER COLUMN original_name SET NOT NULL;
ALTER TABLE policy_documents ALTER COLUMN media_type SET NOT NULL;
ALTER TABLE policy_documents ALTER COLUMN sha256 SET NOT NULL;
ALTER TABLE policy_documents ALTER COLUMN byte_size SET NOT NULL;
ALTER TABLE policy_documents ALTER COLUMN language SET DEFAULT 'und';
ALTER TABLE policy_documents ALTER COLUMN language SET NOT NULL;
ALTER TABLE policy_documents ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE policy_documents ALTER COLUMN status SET NOT NULL;
ALTER TABLE policy_documents ALTER COLUMN uploaded_by_user_id SET NOT NULL;
ALTER TABLE policy_documents ALTER COLUMN extraction_metadata SET DEFAULT '{}'::jsonb;
ALTER TABLE policy_documents ALTER COLUMN extraction_metadata SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'policy_documents_status_check'
      AND conrelid = 'policy_documents'::regclass
  ) THEN
    ALTER TABLE policy_documents ADD CONSTRAINT policy_documents_status_check
      CHECK (status IN ('draft','uploaded','processing','under_review','approved','active','superseded','revoked','failed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'policy_documents_sha256_check'
      AND conrelid = 'policy_documents'::regclass
  ) THEN
    ALTER TABLE policy_documents ADD CONSTRAINT policy_documents_sha256_check
      CHECK (sha256 ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'policy_documents_sizes_check'
      AND conrelid = 'policy_documents'::regclass
  ) THEN
    ALTER TABLE policy_documents ADD CONSTRAINT policy_documents_sizes_check
      CHECK (byte_size >= 0 AND (page_count IS NULL OR page_count > 0));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS policy_tenant_pack_collection_title_version_uq
  ON policy_documents(tenant_id, domain_pack_id, collection_id, title, policy_version);
CREATE INDEX IF NOT EXISTS policy_tenant_status_updated_idx
  ON policy_documents(tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS policy_tenant_hash_idx ON policy_documents(tenant_id, sha256);
CREATE INDEX IF NOT EXISTS policy_domain_pack_idx ON policy_documents(domain_pack_id);
CREATE INDEX IF NOT EXISTS policy_uploaded_by_idx ON policy_documents(uploaded_by_user_id);
CREATE INDEX IF NOT EXISTS policy_approved_by_idx ON policy_documents(approved_by_user_id);

ALTER TABLE policy_chunks ADD COLUMN IF NOT EXISTS page_from integer;
ALTER TABLE policy_chunks ADD COLUMN IF NOT EXISTS page_to integer;
ALTER TABLE policy_chunks ADD COLUMN IF NOT EXISTS heading_path jsonb;
ALTER TABLE policy_chunks ADD COLUMN IF NOT EXISTS source_quote text;
ALTER TABLE policy_chunks ADD COLUMN IF NOT EXISTS embedding_provider text;
ALTER TABLE policy_chunks ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE policy_chunks ADD COLUMN IF NOT EXISTS tags text[];
ALTER TABLE policy_chunks ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;

UPDATE policy_chunks
SET page_from = coalesce(page_from, 1),
    page_to = coalesce(page_to, 1),
    heading_path = coalesce(heading_path, '[]'::jsonb),
    source_quote = coalesce(source_quote, content),
    tags = coalesce(tags, '{}'::text[]);

ALTER TABLE policy_chunks ALTER COLUMN page_from SET NOT NULL;
ALTER TABLE policy_chunks ALTER COLUMN page_to SET NOT NULL;
ALTER TABLE policy_chunks ALTER COLUMN heading_path SET DEFAULT '[]'::jsonb;
ALTER TABLE policy_chunks ALTER COLUMN heading_path SET NOT NULL;
ALTER TABLE policy_chunks ALTER COLUMN source_quote SET NOT NULL;
ALTER TABLE policy_chunks ALTER COLUMN tags SET DEFAULT '{}'::text[];
ALTER TABLE policy_chunks ALTER COLUMN tags SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'policy_chunks_page_range_check'
      AND conrelid = 'policy_chunks'::regclass
  ) THEN
    ALTER TABLE policy_chunks ADD CONSTRAINT policy_chunks_page_range_check
      CHECK (page_from > 0 AND page_to >= page_from);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS policy_chunk_document_page_idx
  ON policy_chunks(policy_document_id, page_from, page_to);
CREATE INDEX IF NOT EXISTS policy_chunks_content_search_idx
  ON policy_chunks USING gin(search_vector);

CREATE TABLE IF NOT EXISTS policy_document_pages (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  policy_document_id text NOT NULL REFERENCES policy_documents(id),
  page_number integer NOT NULL CHECK (page_number > 0),
  extraction_method text NOT NULL CHECK (extraction_method IN ('native','ocr','blank')),
  language text,
  rotation_degrees integer NOT NULL DEFAULT 0 CHECK (rotation_degrees IN (0,90,180,270)),
  text text NOT NULL,
  quality numeric(5,4) NOT NULL CHECK (quality BETWEEN 0 AND 1),
  blocks jsonb NOT NULL DEFAULT '[]',
  warnings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE(policy_document_id, page_number)
);
CREATE INDEX IF NOT EXISTS policy_document_page_scope_idx
  ON policy_document_pages(tenant_id, policy_document_id);

CREATE TABLE IF NOT EXISTS policy_rule_proposals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  policy_document_id text NOT NULL REFERENCES policy_documents(id),
  status text NOT NULL CHECK (status IN ('proposed','invalid','under_review','approved','rejected','activated')),
  title text NOT NULL,
  description text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','minor','major','critical')),
  condition jsonb NOT NULL,
  policy_tags text[] NOT NULL DEFAULT '{}',
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  provider_id text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  validation_issues jsonb NOT NULL DEFAULT '[]',
  proposed_by_user_id text REFERENCES users(id),
  reviewed_by_user_id text REFERENCES users(id),
  review_reason text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((status NOT IN ('approved','rejected','activated')) OR
         (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(review_reason) >= 8))
);
CREATE INDEX IF NOT EXISTS policy_rule_proposal_document_status_idx
  ON policy_rule_proposals(policy_document_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS policy_rule_proposal_tenant_status_idx
  ON policy_rule_proposals(tenant_id, status);
CREATE INDEX IF NOT EXISTS policy_rule_proposal_proposer_idx
  ON policy_rule_proposals(proposed_by_user_id);
CREATE INDEX IF NOT EXISTS policy_rule_proposal_reviewer_idx
  ON policy_rule_proposals(reviewed_by_user_id);

CREATE TABLE IF NOT EXISTS policy_rule_proposal_citations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  proposal_id text NOT NULL REFERENCES policy_rule_proposals(id),
  policy_chunk_id text REFERENCES policy_chunks(id),
  page_number integer NOT NULL CHECK (page_number > 0),
  quote text NOT NULL CHECK (length(btrim(quote)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS policy_rule_citation_proposal_idx
  ON policy_rule_proposal_citations(proposal_id);
CREATE INDEX IF NOT EXISTS policy_rule_citation_chunk_idx
  ON policy_rule_proposal_citations(policy_chunk_id);

CREATE TABLE IF NOT EXISTS policy_rule_proposal_tests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  proposal_id text NOT NULL REFERENCES policy_rule_proposals(id),
  kind text NOT NULL CHECK (kind IN ('match','no_match','missing_value','boundary')),
  name text NOT NULL,
  input jsonb NOT NULL,
  expected boolean NOT NULL,
  actual boolean,
  passed boolean,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE(proposal_id, kind, name)
);
CREATE INDEX IF NOT EXISTS policy_rule_test_proposal_idx
  ON policy_rule_proposal_tests(proposal_id);

CREATE TABLE IF NOT EXISTS policy_rules (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  domain_pack_id text NOT NULL REFERENCES domain_packs(id),
  policy_document_id text NOT NULL REFERENCES policy_documents(id),
  proposal_id text NOT NULL REFERENCES policy_rule_proposals(id),
  rule_key text NOT NULL,
  rule_version integer NOT NULL CHECK (rule_version > 0),
  status text NOT NULL CHECK (status IN ('active','superseded','revoked')),
  title text NOT NULL,
  description text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','minor','major','critical')),
  condition jsonb NOT NULL,
  policy_tags text[] NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 0,
  approved_by_user_id text NOT NULL REFERENCES users(id),
  activated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE(tenant_id, rule_key, rule_version)
);
CREATE INDEX IF NOT EXISTS policy_rule_active_scope_idx
  ON policy_rules(tenant_id, domain_pack_id, status);
CREATE INDEX IF NOT EXISTS policy_rule_document_idx ON policy_rules(policy_document_id);
CREATE INDEX IF NOT EXISTS policy_rule_proposal_idx ON policy_rules(proposal_id);
CREATE INDEX IF NOT EXISTS policy_rule_approver_idx ON policy_rules(approved_by_user_id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'policy_document_pages',
    'policy_rule_proposals',
    'policy_rule_proposal_citations',
    'policy_rule_proposal_tests',
    'policy_rules'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (
        tenant_id = current_setting(''app.tenant_id'', true)
        OR current_setting(''app.platform_admin'', true) = ''true''
      ) WITH CHECK (
        tenant_id = current_setting(''app.tenant_id'', true)
        OR current_setting(''app.platform_admin'', true) = ''true''
      )',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON policy_documents TO caselens_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_chunks TO caselens_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_document_pages TO caselens_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_rule_proposals TO caselens_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_rule_proposal_citations TO caselens_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_rule_proposal_tests TO caselens_runtime;
GRANT SELECT, INSERT, UPDATE ON policy_rules TO caselens_runtime;
