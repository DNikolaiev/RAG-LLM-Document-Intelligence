\set ON_ERROR_STOP on

DO $$ BEGIN
  CREATE ROLE caselens_app LOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER ROLE caselens_app WITH PASSWORD :'runtime_password';
GRANT caselens_runtime TO caselens_app;
