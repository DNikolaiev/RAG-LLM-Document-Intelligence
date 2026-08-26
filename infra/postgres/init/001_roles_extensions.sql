CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$ BEGIN
  CREATE ROLE caselens_runtime LOGIN PASSWORD 'caselens-runtime-local-only';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE ROLE caselens_auditor NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT CONNECT ON DATABASE caselens TO caselens_runtime, caselens_auditor;
GRANT USAGE ON SCHEMA public TO caselens_runtime, caselens_auditor;
