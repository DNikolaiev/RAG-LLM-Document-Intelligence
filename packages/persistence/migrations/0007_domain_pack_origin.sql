-- Where each pack version came from.
--
-- The seed installs every tenant's pack from the compiled catalog; administrators mint new versions
-- by approving fields and creating collections. Nothing recorded which was which, so the seed could
-- not tell a tenant still on the catalog's line - which should receive a newer catalog release -
-- from one its administrators had governed - which must never be overwritten. It upserted on
-- (tenant_id, domain_key, semantic_version), so a catalog release numbered like a version a tenant
-- had already minted would have replaced that tenant's approved definition, and any other newer
-- release collided on the fixed id pack_<tenant> and stopped the API from starting.
--
-- 'catalog' rows are written by the seed, 'tenant' rows by governance. The default is 'tenant', so
-- a writer that does not say otherwise is treated as governed configuration and left alone.

ALTER TABLE domain_packs ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'tenant';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'domain_packs_origin_check'
      AND conrelid = 'domain_packs'::regclass
  ) THEN
    ALTER TABLE domain_packs ADD CONSTRAINT domain_packs_origin_check
      CHECK (origin IN ('catalog','tenant'));
  END IF;
END $$;

-- Backfill. Until now the seed wrote exactly one row per tenant, under the fixed id pack_<tenant>,
-- and every other row was minted by an approval. Re-running this is harmless: a root row is only
-- ever written by the seed.
UPDATE domain_packs SET origin = 'catalog'
WHERE id = 'pack_' || tenant_id AND origin <> 'catalog';
