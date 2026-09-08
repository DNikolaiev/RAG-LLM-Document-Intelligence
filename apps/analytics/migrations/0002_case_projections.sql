-- The projections themselves.
--
-- Shaped for the questions asked of them, not for correctness under concurrent business writes.
-- Counters are denormalised and pre-aggregated; nothing here is normalised, because nothing here is
-- ever written by two actors racing each other. One consumer owns every row.

-- Reference data this service accumulates for itself, from events it has already seen.
--
-- `case.decided` deliberately does not carry the domain pack: an event payload should carry what a
-- consumer needs to interpret the fact, not a copy of a database row. But throughput is more useful
-- split by pack, so the projection remembers what `case.created` told it rather than calling back
-- into the case service - which would put a synchronous dependency on the write side into the read
-- side and undo the separation.
--
-- The consequence is honest and worth seeing: a case decided before this service existed has no
-- remembered dimension, and its decision is attributed to 'unknown' until the outbox is replayed.
-- That gap is the argument for replay, not a flaw to paper over.
CREATE TABLE IF NOT EXISTS case_dimensions (
  case_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  reference text NOT NULL,
  domain_pack_id text NOT NULL,
  domain_pack_version text NOT NULL,
  created_at timestamptz NOT NULL
);

-- Cases in and decisions out, per tenant per day per pack.
--
-- Days are bucketed in UTC. A tenant operating in one timezone would rather see its own calendar
-- day, which needs a per-tenant timezone this service is not told about; until an event carries one,
-- UTC is the honest choice rather than the host's accidental locale.
CREATE TABLE IF NOT EXISTS case_throughput_daily (
  tenant_id text NOT NULL,
  day date NOT NULL,
  domain_pack_id text NOT NULL,
  created integer NOT NULL DEFAULT 0,
  decided integer NOT NULL DEFAULT 0,
  approved integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  information_requested integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, domain_pack_id)
);

-- One row per decided case, not a running average.
--
-- An average hides the tail, and the tail is the interesting part: a median of two days with a p90
-- of three weeks is a different operation from one where both are two days. Keeping the rows lets
-- the read API compute real percentiles with percentile_cont.
CREATE TABLE IF NOT EXISTS case_cycle_time (
  case_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  created_at timestamptz NOT NULL,
  decided_at timestamptz NOT NULL,
  seconds_to_decision integer NOT NULL,
  outcome text NOT NULL
);

CREATE INDEX IF NOT EXISTS case_cycle_tenant_decided_idx
  ON case_cycle_time (tenant_id, decided_at);
CREATE INDEX IF NOT EXISTS case_throughput_tenant_day_idx
  ON case_throughput_daily (tenant_id, day);
