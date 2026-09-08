-- The analytics read model's own schema, in its own database, on its own server.
--
-- Nothing here references the case pipeline's tables and nothing there references these. The two
-- schemas are allowed to disagree: this one is shaped for the questions it answers, not for
-- correctness under concurrent business writes. That is the whole point of a read model.
--
-- There is no row-level security here, unlike the main database. RLS there protects a schema many
-- roles reach through one API; this database has exactly one client, which is this service, and
-- tenant scope is enforced where the read API builds its queries. Adding RLS would be ceremony
-- without a threat model behind it.

-- Every event this service has already applied. The idempotency key is the event id, which the
-- publisher derives deterministically, so the same fact recorded twice is the same id.
--
-- Delivery is at-least-once and always will be: the relay may crash between the broker's confirm
-- and its own published_at stamp, and republish on the next pass. That is not a bug to fix, it is
-- the guarantee the transport offers. This table is how the consumer copes with it.
CREATE TABLE IF NOT EXISTS processed_events (
  event_id text PRIMARY KEY,
  sequence bigint NOT NULL,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- How far each projection has consumed. Compared against max(sequence) in the publisher's outbox,
-- this is consumer lag - the number that makes eventual consistency a measurement rather than a
-- word.
CREATE TABLE IF NOT EXISTS projection_state (
  name text PRIMARY KEY,
  last_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Answers "what has this service seen recently", and orders a replay.
CREATE INDEX IF NOT EXISTS processed_event_sequence_idx ON processed_events (sequence);
