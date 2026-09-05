-- The transactional outbox.
--
-- A domain event is appended here in the SAME transaction as the business change it describes,
-- so the two commit or roll back together. Publishing to a broker separately from writing the
-- business row is a dual write: if the process dies between them, the state changes and the fact
-- is lost with no trace that it should have existed. Writing both here removes the second write.
--
-- The table is also the event log. RabbitMQ delivers to live consumers, but an acknowledged
-- message is gone, so a projection that needs rebuilding replays from these rows instead.
-- Nothing deletes from this table; `published_at` records delivery, it does not consume the row.

CREATE TABLE IF NOT EXISTS domain_events (
  id text PRIMARY KEY,
  -- Monotonic per database, assigned at insert. Replay orders by this rather than occurred_at,
  -- which is only as good as the clock that produced it.
  sequence bigserial NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id),
  type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Null until the relay has handed the event to the broker. The relay may crash after
  -- publishing and before stamping this, which is why delivery is at-least-once and consumers
  -- must be idempotent.
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The relay's query: the oldest unpublished events, in order.
CREATE INDEX IF NOT EXISTS domain_event_unpublished_idx
  ON domain_events(sequence)
  WHERE published_at IS NULL;

-- Replay's query: one aggregate's or one tenant's history, in order.
CREATE INDEX IF NOT EXISTS domain_event_tenant_sequence_idx
  ON domain_events(tenant_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS domain_event_sequence_uq ON domain_events(sequence);

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON domain_events;
CREATE POLICY tenant_isolation ON domain_events USING (
  tenant_id = current_setting('app.tenant_id', true)
  OR current_setting('app.platform_admin', true) = 'true'
) WITH CHECK (
  tenant_id = current_setting('app.tenant_id', true)
  OR current_setting('app.platform_admin', true) = 'true'
);

-- No DELETE. The log is append-only; the relay only ever stamps published_at.
GRANT SELECT, INSERT, UPDATE ON domain_events TO caselens_runtime;
GRANT USAGE, SELECT ON SEQUENCE domain_events_sequence_seq TO caselens_runtime;
