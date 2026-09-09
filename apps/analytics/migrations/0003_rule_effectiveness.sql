-- Which rules fire, and whether firing changed anything.
--
-- The question this answers is the one the transactional schema is worst at and nobody would build
-- a page for: a rule that raises a critical finding four hundred times and is approved anyway is
-- costing reviewer attention every day and producing nothing. Spotting that from the case list
-- means reading hundreds of closed cases.
--
-- It needs two event types correlated across time - findings raised during processing, and the
-- decision that case eventually received - which is precisely the shape a read model exists for.

-- Which rules fired on which case, accumulated from `finding.raised` as it arrives.
--
-- Reference data the service keeps for itself, like `case_dimensions`. A decision does not carry
-- the findings that preceded it and should not: an event payload carries what a consumer needs to
-- interpret that fact, not a join's worth of related rows.
--
-- Keyed by (case_id, rule_key) rather than the finding id, because the same rule firing twice on
-- one case is the same statement about that rule for this purpose.
CREATE TABLE IF NOT EXISTS case_findings (
  case_id text NOT NULL,
  rule_key text NOT NULL,
  tenant_id text NOT NULL,
  severity text NOT NULL,
  PRIMARY KEY (case_id, rule_key)
);

CREATE INDEX IF NOT EXISTS case_findings_case_idx ON case_findings (case_id);

-- One row per rule and severity, with what happened to the cases it fired on.
--
-- `then_*` counters only move when a decision arrives for a case whose findings were already
-- projected. A decision for a case with no recorded findings contributes to nothing here, which is
-- correct: the read model cannot claim a rule influenced an outcome it never saw.
CREATE TABLE IF NOT EXISTS rule_effectiveness (
  tenant_id text NOT NULL,
  rule_key text NOT NULL,
  severity text NOT NULL,
  times_raised integer NOT NULL DEFAULT 0,
  then_approved integer NOT NULL DEFAULT 0,
  then_rejected integer NOT NULL DEFAULT 0,
  then_information_requested integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, rule_key, severity)
);
