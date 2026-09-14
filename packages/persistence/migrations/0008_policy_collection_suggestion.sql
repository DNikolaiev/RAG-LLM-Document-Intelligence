-- A policy may exist before its collection is decided.
--
-- Classification reads a policy's text before anyone has said which collection it belongs to, and
-- pauses for an administrator when it cannot file it confidently (see
-- docs/superpowers/plans/2026-09-14-policy-collection-classification.md). Until then the policy
-- genuinely has no collection, so collection_id becomes nullable - but only while nothing governed
-- depends on it, which the constraints below hold the database to.
--
-- This migration is not safe to replay, and does not need to be: infra/postgres/migrate.sh applies
-- each numbered file once and records it in schema_migrations.

ALTER TABLE policy_documents ALTER COLUMN collection_id DROP NOT NULL;

-- What classification suggested and why, kept with the policy: decision, collection or proposed
-- label, confidence, the verbatim quotation, and which model at which pack version said so.
ALTER TABLE policy_documents ADD COLUMN IF NOT EXISTS collection_suggestion jsonb;

ALTER TABLE policy_documents DROP CONSTRAINT IF EXISTS policy_documents_status_check;
ALTER TABLE policy_documents ADD CONSTRAINT policy_documents_status_check
  CHECK (status IN ('draft','uploaded','processing','awaiting_collection','under_review',
                    'approved','active','superseded','revoked','failed'));

-- An unfiled policy can be uploaded, processing, waiting or failed - never under review, approved
-- or active. Rules derived from a policy are keyed by its collection, so the database refuses a
-- governed policy without one instead of trusting every code path to check.
ALTER TABLE policy_documents ADD CONSTRAINT policy_documents_collection_filed_check
  CHECK (collection_id IS NOT NULL
         OR status IN ('draft','uploaded','processing','awaiting_collection','failed'));

-- Waiting for a collection means not having one.
ALTER TABLE policy_documents ADD CONSTRAINT policy_documents_awaiting_unfiled_check
  CHECK (status <> 'awaiting_collection' OR collection_id IS NULL);

ALTER TABLE policy_documents ADD CONSTRAINT policy_documents_collection_suggestion_check
  CHECK (collection_suggestion IS NULL OR jsonb_typeof(collection_suggestion) = 'object');

-- One title and version per collection - and, now that the collection can be NULL, at most one
-- unfiled copy as well. A unique index treats NULLs as distinct by default, which would let the same
-- title and version be uploaded unfiled any number of times.
DROP INDEX IF EXISTS policy_tenant_pack_collection_title_version_uq;
CREATE UNIQUE INDEX policy_tenant_pack_collection_title_version_uq
  ON policy_documents(tenant_id, domain_pack_id, collection_id, title, policy_version)
  NULLS NOT DISTINCT;
