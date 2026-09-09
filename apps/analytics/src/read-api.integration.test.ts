import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { DomainEvent } from '@caselens/events';
import { AnalyticsStore, PROJECTION_NAME } from './store.js';
import { project } from './projections.js';
import { startReadApi } from './read-api.js';
import type { CallerContext } from './caller.js';

const databaseUrl = process.env.TEST_ANALYTICS_DATABASE_URL;
const port = 41_997;

describe.skipIf(!databaseUrl)('analytics read API', () => {
  const store = databaseUrl ? new AnalyticsStore(databaseUrl) : null;
  const sql = databaseUrl ? postgres(databaseUrl, { prepare: false }) : null;
  const tenantA = `tenant_read_a_${Date.now().toString(36)}`;
  const tenantB = `tenant_read_b_${Date.now().toString(36)}`;
  let caller: CallerContext = { tenantIds: [tenantA], platformAdmin: false };
  const server = databaseUrl
    ? startReadApi({ store: store!, port, resolve: () => caller })
    : undefined;

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from case_throughput_daily where tenant_id in (${tenantA}, ${tenantB})`;
    await sql`delete from case_cycle_time where tenant_id in (${tenantA}, ${tenantB})`;
    await sql`delete from case_dimensions where tenant_id in (${tenantA}, ${tenantB})`;
    await sql`delete from processed_events where event_id like ${`%read_${tenantA}%`}
      or event_id like ${`%read_${tenantB}%`}`;
    await sql`delete from projection_state where name = ${PROJECTION_NAME}`;
    await sql.end();
    await store?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('answers only for the tenants the caller belongs to', async () => {
    await seed(store!, tenantA, 'approve', '2026-09-01T09:00:00.000Z', '2026-09-02T09:00:00.000Z');
    await seed(store!, tenantB, 'reject', '2026-09-01T09:00:00.000Z', '2026-09-05T09:00:00.000Z');

    // A member of one tenant must not see the other's volumes, even in aggregate. Counts leak
    // business information - how much work a competitor handles - so scope is not a nicety.
    caller = { tenantIds: [tenantA], platformAdmin: false };
    const scoped = await get<{ days: Array<{ created: number }> }>('/v1/analytics/throughput');
    expect(scoped.days.reduce((total, day) => total + day.created, 0)).toBe(1);

    const cycle = await get<{ decided: number; medianSeconds: number }>('/v1/analytics/cycle-time');
    expect(cycle.decided).toBe(1);
    // One day, in seconds.
    expect(cycle.medianSeconds).toBe(86_400);

    // The platform administrator's cross-tenant view is the query row-level security exists to stop
    // in the transactional schema, and the one this read model answers without a bypass.
    caller = { tenantIds: [], platformAdmin: true };
    const all = await get<{ decided: number; medianSeconds: number }>('/v1/analytics/cycle-time');
    expect(all.decided).toBeGreaterThanOrEqual(2);
    // Median of one day and four days.
    expect(all.medianSeconds).toBeGreaterThanOrEqual(86_400);
  });

  it('returns nothing for a caller with no memberships rather than everything', async () => {
    // `in ()` is not valid SQL, and the tempting workaround is to drop the predicate entirely -
    // which turns an unaffiliated caller into a platform administrator.
    caller = { tenantIds: [], platformAdmin: false };
    const empty = await get<{ days: unknown[] }>('/v1/analytics/throughput');
    expect(empty.days).toEqual([]);
  });

  it('answers liveness before it considers identity', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function seed(
  store: AnalyticsStore,
  tenantId: string,
  outcome: 'approve' | 'reject',
  createdAt: string,
  decidedAt: string,
): Promise<void> {
  const caseId = `case_read_${tenantId}`;
  const create = {
    id: `evt_read_${tenantId}_c`,
    type: 'case.created',
    tenantId,
    aggregateType: 'case',
    aggregateId: caseId,
    occurredAt: createdAt,
    sequence: Math.floor(Math.random() * 1_000_000),
    payload: { reference: 'READ-1', domainPackId: 'pack_a', domainPackVersion: '1.0.0' },
  } as DomainEvent;
  const decide = {
    id: `evt_read_${tenantId}_d`,
    type: 'case.decided',
    tenantId,
    aggregateType: 'case',
    aggregateId: caseId,
    occurredAt: decidedAt,
    sequence: Math.floor(Math.random() * 1_000_000),
    payload: { reference: 'READ-1', outcome, decidedByUserId: 'user_a', caseCreatedAt: createdAt },
  } as DomainEvent;

  await store.apply(create, (tx) => project(tx, create));
  await store.apply(decide, (tx) => project(tx, decide));
}
