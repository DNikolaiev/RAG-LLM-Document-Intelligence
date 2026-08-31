DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'memberships','domain_packs','cases','documents','document_pages','extraction_runs','evidence_spans',
    'extracted_facts','policy_documents','policy_chunks','policy_search_chunks','rule_runs','findings','decisions','workflow_checkpoints','audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) OR current_setting(''app.platform_admin'', true) = ''true'') WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) OR current_setting(''app.platform_admin'', true) = ''true'')', table_name);
  END LOOP;
END $$;

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON jobs;
DROP POLICY IF EXISTS job_select_visibility ON jobs;
DROP POLICY IF EXISTS job_write_scope ON jobs;
CREATE POLICY job_select_visibility ON jobs FOR SELECT USING (
  current_setting('app.platform_admin', true) = 'true'
  OR current_setting('app.system_actor', true) = 'true'
  OR (
    tenant_id = current_setting('app.tenant_id', true)
    AND enqueued_by_user_id = current_setting('app.user_id', true)
  )
);
CREATE POLICY job_write_scope ON jobs FOR ALL USING (
  current_setting('app.platform_admin', true) = 'true'
  OR current_setting('app.system_actor', true) = 'true'
  OR (
    tenant_id = current_setting('app.tenant_id', true)
    AND enqueued_by_user_id = current_setting('app.user_id', true)
  )
) WITH CHECK (
  current_setting('app.platform_admin', true) = 'true'
  OR current_setting('app.system_actor', true) = 'true'
  OR (
    tenant_id = current_setting('app.tenant_id', true)
    AND enqueued_by_user_id = current_setting('app.user_id', true)
  )
);

ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_events;
DROP POLICY IF EXISTS job_event_select_visibility ON job_events;
DROP POLICY IF EXISTS job_event_insert_scope ON job_events;
DROP POLICY IF EXISTS job_event_update_own ON job_events;
CREATE POLICY job_event_select_visibility ON job_events FOR SELECT USING (
  current_setting('app.platform_admin', true) = 'true'
  OR current_setting('app.system_actor', true) = 'true'
  OR (
    tenant_id = current_setting('app.tenant_id', true)
    AND recipient_user_id = current_setting('app.user_id', true)
  )
);
CREATE POLICY job_event_insert_scope ON job_events FOR INSERT WITH CHECK (
  current_setting('app.platform_admin', true) = 'true'
  OR current_setting('app.system_actor', true) = 'true'
  OR (
    tenant_id = current_setting('app.tenant_id', true)
    AND recipient_user_id = current_setting('app.user_id', true)
  )
);
CREATE POLICY job_event_update_own ON job_events FOR UPDATE USING (
  tenant_id = current_setting('app.tenant_id', true)
  AND recipient_user_id = current_setting('app.user_id', true)
) WITH CHECK (
  tenant_id = current_setting('app.tenant_id', true)
  AND recipient_user_id = current_setting('app.user_id', true)
);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO caselens_runtime;
REVOKE UPDATE, DELETE ON audit_events FROM caselens_runtime;
GRANT SELECT, INSERT ON audit_events TO caselens_runtime;
GRANT SELECT ON audit_events TO caselens_auditor;
