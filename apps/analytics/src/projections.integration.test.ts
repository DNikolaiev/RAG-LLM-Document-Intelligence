import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { DomainEvent } from '@caselens/events';
import { AnalyticsStore, PROJECTION_NAME } from './store.js';
import { project, UNKNOWN_PACK } from './projections.js';

const databaseUrl = process.env.TEST_ANALYTICS_DATABASE_URL;

describe.skipIf(!databaseUrl)('case projections', () => {
  it('counts intake and decisions, and measures the gap between them', async () => {
    const store = new AnalyticsStore(databaseUrl!);
    const sql = postgres(databaseUrl!, { prepare: false });
    const tenantId = `tenant_proj_${Date.now().toString(36)}`;
    const caseId = `case_${tenantId}`;

    try {
      await store.apply(created(caseId, tenantId, '2026-09-01T09:00:00.000Z'), (tx) =>
        project(tx, created(caseId, tenantId, '2026-09-01T09:00:00.000Z')),
      );
      const decision = decided(caseId, tenantId, '2026-09-03T09:00:00.000Z', {
        outcome: 'approve',
        caseCreatedAt: '2026-09-01T09:00:00.000Z',
      });
      await store.apply(decision, (tx) => project(tx, decision));

      const throughput = await sql`
        select day::text, domain_pack_id, created, decided, approved from case_throughput_daily
        where tenant_id = ${tenantId} order by day`;
      // The creation and the decision fall on different days, so they are different rows - which is
      // the shape a throughput chart wants and the transactional schema would have to derive.
      expect(throughput).toEqual([
        {
          day: '2026-09-01',
          domain_pack_id: 'pack_a',
          created: 1,
          decided: 0,
          approved: 0,
        },
        {
          day: '2026-09-03',
          domain_pack_id: 'pack_a',
          created: 0,
          decided: 1,
          approved: 1,
        },
      ]);

      // Two days, in seconds, computed from the payload alone - no lookup into the case service.
      const cycle = await sql<Array<{ seconds_to_decision: number; outcome: string }>>`
        select seconds_to_decision, outcome from case_cycle_time where case_id = ${caseId}`;
      expect(cycle[0]).toEqual({ seconds_to_decision: 172_800, outcome: 'approve' });
    } finally {
      await cleanup(sql, tenantId, caseId);
      await store.close();
    }
  });

  it('does not count a superseding decision twice', async () => {
    // Re-deciding one case must correct the cycle time and leave the day's decision count alone.
    // Incrementing again would inflate throughput and make the read model quietly disagree with
    // reality - the kind of drift nobody notices until a number is used for something.
    const store = new AnalyticsStore(databaseUrl!);
    const sql = postgres(databaseUrl!, { prepare: false });
    const tenantId = `tenant_redecide_${Date.now().toString(36)}`;
    const caseId = `case_${tenantId}`;

    try {
      const create = created(caseId, tenantId, '2026-09-01T09:00:00.000Z');
      await store.apply(create, (tx) => project(tx, create));

      const first = decided(caseId, tenantId, '2026-09-02T09:00:00.000Z', {
        outcome: 'reject',
        caseCreatedAt: '2026-09-01T09:00:00.000Z',
        id: `${caseId}_d1`,
      });
      await store.apply(first, (tx) => project(tx, first));

      const second = decided(caseId, tenantId, '2026-09-04T09:00:00.000Z', {
        outcome: 'approve',
        caseCreatedAt: '2026-09-01T09:00:00.000Z',
        id: `${caseId}_d2`,
      });
      await store.apply(second, (tx) => project(tx, second));

      expect(
        await sql`select sum(decided)::int as decided, sum(approved)::int as approved,
          sum(rejected)::int as rejected from case_throughput_daily where tenant_id = ${tenantId}`,
      ).toEqual([{ decided: 1, approved: 0, rejected: 1 }]);

      // The cycle-time row is corrected to the decision that stands.
      const cycle = await sql<Array<{ outcome: string; seconds_to_decision: number }>>`
        select outcome, seconds_to_decision from case_cycle_time where case_id = ${caseId}`;
      expect(cycle[0]).toEqual({ outcome: 'approve', seconds_to_decision: 259_200 });
    } finally {
      await cleanup(sql, tenantId, caseId);
      await store.close();
    }
  });

  it('marks a decision it has no history for rather than inventing a pack', async () => {
    // A case decided before this service existed. The honest answer is that the history runs out
    // here, and replay is what fills it in - not a plausible-looking guess.
    const store = new AnalyticsStore(databaseUrl!);
    const sql = postgres(databaseUrl!, { prepare: false });
    const tenantId = `tenant_orphan_${Date.now().toString(36)}`;
    const caseId = `case_${tenantId}`;

    try {
      const decision = decided(caseId, tenantId, '2026-09-05T09:00:00.000Z', {
        outcome: 'request_information',
        caseCreatedAt: '2026-09-05T08:00:00.000Z',
      });
      await store.apply(decision, (tx) => project(tx, decision));

      expect(
        await sql`select domain_pack_id, decided, information_requested from case_throughput_daily
          where tenant_id = ${tenantId}`,
      ).toEqual([{ domain_pack_id: UNKNOWN_PACK, decided: 1, information_requested: 1 }]);
    } finally {
      await cleanup(sql, tenantId, caseId);
      await store.close();
    }
  });
});

async function cleanup(sql: postgres.Sql, tenantId: string, caseId: string): Promise<void> {
  await sql`delete from case_throughput_daily where tenant_id = ${tenantId}`;
  await sql`delete from case_cycle_time where tenant_id = ${tenantId}`;
  await sql`delete from case_dimensions where tenant_id = ${tenantId}`;
  await sql`delete from processed_events where event_id like ${`%${caseId}%`}`;
  await sql`delete from projection_state where name = ${PROJECTION_NAME}`;
  await sql.end();
}

function created(caseId: string, tenantId: string, occurredAt: string): DomainEvent {
  return {
    id: `${caseId}_c`,
    type: 'case.created',
    tenantId,
    aggregateType: 'case',
    aggregateId: caseId,
    occurredAt,
    sequence: Date.now() % 1_000_000,
    payload: { reference: 'PROJ-1', domainPackId: 'pack_a', domainPackVersion: '1.0.0' },
  } as DomainEvent;
}

function decided(
  caseId: string,
  tenantId: string,
  occurredAt: string,
  options: {
    outcome: 'approve' | 'reject' | 'request_information';
    caseCreatedAt: string;
    id?: string;
  },
): DomainEvent {
  return {
    id: options.id ?? `${caseId}_d`,
    type: 'case.decided',
    tenantId,
    aggregateType: 'case',
    aggregateId: caseId,
    occurredAt,
    sequence: (Date.now() % 1_000_000) + 1,
    payload: {
      reference: 'PROJ-1',
      outcome: options.outcome,
      decidedByUserId: 'user_a',
      caseCreatedAt: options.caseCreatedAt,
    },
  } as DomainEvent;
}
