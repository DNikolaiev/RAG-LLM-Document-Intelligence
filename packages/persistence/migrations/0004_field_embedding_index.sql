-- Field embedding index: the searchable vocabulary of a tenant's active pack.
--
-- `field_proposals` records what a policy proposed and how it was governed. It is not a search
-- index: a field that ships inside the compiled domain pack was never proposed, so it has no
-- proposal row and could never be recalled. Recall therefore reads this table, which indexes
-- every field of the current pack regardless of where the field came from.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS field_embeddings (
  tenant_id text NOT NULL REFERENCES tenants(id),
  domain_pack_id text NOT NULL REFERENCES domain_packs(id),
  path text NOT NULL CHECK (path ~ '^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$'),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  aliases text[] NOT NULL DEFAULT '{}',
  embedding vector(768) NOT NULL,
  -- Stable hash of label plus sorted aliases: an entry whose wording did not change is
  -- skipped by the worker's sync step instead of being embedded again.
  fingerprint text NOT NULL CHECK (length(btrim(fingerprint)) > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One row per field per pack per tenant; the sync step upserts on this key.
  CONSTRAINT field_embeddings_pkey PRIMARY KEY (tenant_id, domain_pack_id, path)
);

CREATE INDEX IF NOT EXISTS field_embedding_embedding_hnsw_idx
  ON field_embeddings USING hnsw (embedding vector_cosine_ops);

ALTER TABLE field_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_embeddings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON field_embeddings;
CREATE POLICY tenant_isolation ON field_embeddings USING (
  tenant_id = current_setting('app.tenant_id', true)
  OR current_setting('app.platform_admin', true) = 'true'
) WITH CHECK (
  tenant_id = current_setting('app.tenant_id', true)
  OR current_setting('app.platform_admin', true) = 'true'
);

GRANT SELECT, INSERT, UPDATE, DELETE ON field_embeddings TO caselens_runtime;
