import type postgres from 'postgres';
import type { DomainEvent } from '@caselens/events';

/**
 * Attributed to this when a decision arrives for a case whose creation this service never saw -
 * because it was decided before analytics existed, or because the queue was rebuilt. Visible on
 * purpose: a read model built from a partial event history has gaps, and hiding them behind a
 * plausible-looking number would be worse than showing where the history runs out. Replay is what
 * closes it.
 */
export const UNKNOWN_PACK = 'unknown';

/**
 * Applies one event to the projections. Runs inside the transaction that claims the event id, so a
 * throw here rolls the claim back too and the event stays deliverable.
 */
export async function project(tx: postgres.TransactionSql, event: DomainEvent): Promise<void> {
  if (event.type === 'case.created') return projectCaseCreated(tx, event);
  if (event.type === 'case.decided') return projectCaseDecided(tx, event);
  // `finding.raised` is bound and will arrive once the worker emits it; it has no counters yet, so
  // it is claimed and ignored rather than dead-lettered. Ignoring is the right default for a
  // consumer that has simply not caught up with the contract.
}

async function projectCaseCreated(tx: postgres.TransactionSql, event: DomainEvent): Promise<void> {
  const payload = event.payload as {
    reference: string;
    domainPackId: string;
    domainPackVersion: string;
  };

  // Remembered so a later decision can be attributed without asking the case service anything.
  await tx`
    insert into case_dimensions (case_id, tenant_id, reference, domain_pack_id, domain_pack_version, created_at)
    values (${event.aggregateId}, ${event.tenantId}, ${payload.reference}, ${payload.domainPackId},
      ${payload.domainPackVersion}, ${event.occurredAt}::timestamptz)
    on conflict (case_id) do nothing`;

  await bumpThroughput(tx, event.tenantId, event.occurredAt, payload.domainPackId, {
    created: 1,
  });
}

async function projectCaseDecided(tx: postgres.TransactionSql, event: DomainEvent): Promise<void> {
  const payload = event.payload as {
    outcome: 'approve' | 'reject' | 'request_information';
    decidedByUserId: string;
    caseCreatedAt: string;
  };

  const dimensions = await tx<Array<{ domain_pack_id: string }>>`
    select domain_pack_id from case_dimensions where case_id = ${event.aggregateId}`;
  const packId = dimensions[0]?.domain_pack_id ?? UNKNOWN_PACK;

  // `caseCreatedAt` rides on the event precisely so this needs no lookup. A consumer that had to
  // query the case service to interpret a fact would be coupled to it at read time, which is the
  // coupling the event exists to remove.
  const createdAt = new Date(payload.caseCreatedAt);
  const decidedAt = new Date(event.occurredAt);
  const seconds = Math.max(0, Math.round((decidedAt.getTime() - createdAt.getTime()) / 1000));

  // A decision can supersede an earlier one on the same case, which produces a second event with
  // its own id. The cycle-time row is keyed by case and overwritten, but the throughput counter
  // must only move the first time - otherwise re-deciding one case inflates the day's decision
  // count, and the read model quietly disagrees with reality.
  const existing = await tx<Array<{ case_id: string }>>`
    select case_id from case_cycle_time where case_id = ${event.aggregateId}`;
  const isFirstDecision = existing.length === 0;

  await tx`
    insert into case_cycle_time (case_id, tenant_id, created_at, decided_at, seconds_to_decision, outcome)
    values (${event.aggregateId}, ${event.tenantId}, ${createdAt.toISOString()}::timestamptz,
      ${decidedAt.toISOString()}::timestamptz, ${seconds}, ${payload.outcome})
    on conflict (case_id) do update
      set decided_at = excluded.decided_at,
        seconds_to_decision = excluded.seconds_to_decision,
        outcome = excluded.outcome`;

  if (!isFirstDecision) return;
  await bumpThroughput(tx, event.tenantId, event.occurredAt, packId, {
    decided: 1,
    approved: payload.outcome === 'approve' ? 1 : 0,
    rejected: payload.outcome === 'reject' ? 1 : 0,
    informationRequested: payload.outcome === 'request_information' ? 1 : 0,
  });
}

interface ThroughputDelta {
  created?: number;
  decided?: number;
  approved?: number;
  rejected?: number;
  informationRequested?: number;
}

/**
 * Upserts one day's counters. `insert ... on conflict do update` rather than read-modify-write
 * because the increment then happens inside the database, in one statement, and cannot lose an
 * update to a concurrent consumer instance.
 */
async function bumpThroughput(
  tx: postgres.TransactionSql,
  tenantId: string,
  occurredAt: string,
  domainPackId: string,
  delta: ThroughputDelta,
): Promise<void> {
  const day = occurredAt.slice(0, 10);
  const created = delta.created ?? 0;
  const decided = delta.decided ?? 0;
  const approved = delta.approved ?? 0;
  const rejected = delta.rejected ?? 0;
  const informationRequested = delta.informationRequested ?? 0;

  await tx`
    insert into case_throughput_daily (tenant_id, day, domain_pack_id, created, decided, approved,
      rejected, information_requested)
    values (${tenantId}, ${day}::date, ${domainPackId}, ${created}, ${decided}, ${approved},
      ${rejected}, ${informationRequested})
    on conflict (tenant_id, day, domain_pack_id) do update
      set created = case_throughput_daily.created + excluded.created,
        decided = case_throughput_daily.decided + excluded.decided,
        approved = case_throughput_daily.approved + excluded.approved,
        rejected = case_throughput_daily.rejected + excluded.rejected,
        information_requested = case_throughput_daily.information_requested
          + excluded.information_requested`;
}
