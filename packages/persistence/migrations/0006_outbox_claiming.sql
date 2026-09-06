-- Two problems with the first outbox relay, both invisible until they bite.
--
-- 1. A row that can never be published was re-read on every poll forever. One such row is noise;
--    enough of them fill the batch entirely and the relay silently stops delivering anything
--    while still looking healthy. `publish_attempts` and `failed_at` let a hopeless row be set
--    aside so it stops consuming a slot.
--
-- 2. The relay read with a plain SELECT, so two relay instances would read the same rows and
--    publish everything twice. The read is now a claim (`FOR UPDATE SKIP LOCKED`), which needs no
--    schema change but is recorded here because it is the same fix.
--
-- Nothing is deleted. A quarantined row keeps its payload and its place in the sequence, so a
-- replay can still see it and a human can still work out what the publisher got wrong.

ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS failed_at timestamptz;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS last_error text;

-- The relay's query: unpublished, not yet given up on, oldest first. Quarantined rows drop out of
-- this index entirely, which is the point - they can no longer crowd out deliverable events.
DROP INDEX IF EXISTS domain_event_unpublished_idx;
CREATE INDEX IF NOT EXISTS domain_event_deliverable_idx
  ON domain_events(sequence)
  WHERE published_at IS NULL AND failed_at IS NULL;

-- Operators need to find what was given up on without scanning the whole log.
CREATE INDEX IF NOT EXISTS domain_event_failed_idx
  ON domain_events(failed_at)
  WHERE failed_at IS NOT NULL;
