DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'memberships','domain_packs','cases','documents','document_pages','extraction_runs','evidence_spans',
    'extracted_facts','policy_documents','policy_chunks','policy_search_chunks','rule_runs','findings','decisions','jobs','workflow_checkpoints','audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) OR current_setting(''app.platform_admin'', true) = ''true'') WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) OR current_setting(''app.platform_admin'', true) = ''true'')', table_name);
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO caselens_runtime;
REVOKE UPDATE, DELETE ON audit_events FROM caselens_runtime;
GRANT SELECT, INSERT ON audit_events TO caselens_runtime;
GRANT SELECT ON audit_events TO caselens_auditor;
