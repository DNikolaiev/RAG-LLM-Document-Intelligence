ALTER TABLE jobs ADD COLUMN IF NOT EXISTS enqueued_by_user_id text REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS correlation_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS queue_job_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS target_type text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS target_id text;

-- Existing local rows predate actor-scoped notifications. Attribute them to the
-- first tenant administrator only so the columns can become mandatory without
-- exposing them to unrelated profiles.
UPDATE jobs AS job
SET enqueued_by_user_id = (
  SELECT user_id
  FROM memberships AS membership
  WHERE membership.tenant_id = job.tenant_id
  ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, user_id
  LIMIT 1
)
WHERE job.enqueued_by_user_id IS NULL;
UPDATE jobs SET correlation_id = 'migration:' || id WHERE correlation_id IS NULL;
UPDATE jobs SET target_type = 'case', target_id = case_id WHERE target_type IS NULL OR target_id IS NULL;

ALTER TABLE jobs ALTER COLUMN enqueued_by_user_id SET NOT NULL;
ALTER TABLE jobs ALTER COLUMN correlation_id SET NOT NULL;
ALTER TABLE jobs ALTER COLUMN target_type SET NOT NULL;
ALTER TABLE jobs ALTER COLUMN target_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS job_enqueuer_updated_idx
  ON jobs(enqueued_by_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS job_tenant_enqueuer_updated_idx
  ON jobs(tenant_id, enqueued_by_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS job_tenant_target_idx
  ON jobs(tenant_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS job_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  job_id text NOT NULL REFERENCES jobs(id),
  recipient_user_id text NOT NULL REFERENCES users(id),
  actor_user_id text REFERENCES users(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  stage text,
  status text NOT NULL,
  progress integer NOT NULL CHECK (progress BETWEEN 0 AND 100),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE(job_id, sequence)
);
CREATE INDEX IF NOT EXISTS job_event_tenant_recipient_time_idx
  ON job_events(tenant_id, recipient_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS job_event_job_time_idx
  ON job_events(job_id, occurred_at DESC);

ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_events;
DROP POLICY IF EXISTS job_event_select_visibility ON job_events;
DROP POLICY IF EXISTS job_event_insert_scope ON job_events;
DROP POLICY IF EXISTS job_event_update_own ON job_events;
CREATE POLICY job_event_select_visibility ON job_events FOR SELECT USING (
  current_setting('app.platform_admin', true) = 'true'
  OR current_setting('app.system_actor', true) = 'true'
  OR (tenant_id = current_setting('app.tenant_id', true) AND recipient_user_id = current_setting('app.user_id', true))
);
CREATE POLICY job_event_insert_scope ON job_events FOR INSERT WITH CHECK (
  current_setting('app.platform_admin', true) = 'true'
  OR current_setting('app.system_actor', true) = 'true'
  OR (tenant_id = current_setting('app.tenant_id', true) AND recipient_user_id = current_setting('app.user_id', true))
);
CREATE POLICY job_event_update_own ON job_events FOR UPDATE USING (
  tenant_id = current_setting('app.tenant_id', true)
  AND recipient_user_id = current_setting('app.user_id', true)
) WITH CHECK (
  tenant_id = current_setting('app.tenant_id', true)
  AND recipient_user_id = current_setting('app.user_id', true)
);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON jobs;
DROP POLICY IF EXISTS job_select_visibility ON jobs;
DROP POLICY IF EXISTS job_write_scope ON jobs;
CREATE POLICY job_select_visibility ON jobs FOR SELECT USING (
  current_setting('app.platform_admin', true) = 'true'
  OR current_setting('app.system_actor', true) = 'true'
  OR (tenant_id = current_setting('app.tenant_id', true) AND enqueued_by_user_id = current_setting('app.user_id', true))
);
CREATE POLICY job_write_scope ON jobs FOR ALL USING (
  current_setting('app.platform_admin', true) = 'true'
  OR current_setting('app.system_actor', true) = 'true'
  OR (tenant_id = current_setting('app.tenant_id', true) AND enqueued_by_user_id = current_setting('app.user_id', true))
) WITH CHECK (
  current_setting('app.platform_admin', true) = 'true'
  OR current_setting('app.system_actor', true) = 'true'
  OR (tenant_id = current_setting('app.tenant_id', true) AND enqueued_by_user_id = current_setting('app.user_id', true))
);
GRANT SELECT, INSERT, UPDATE ON job_events TO caselens_runtime;
