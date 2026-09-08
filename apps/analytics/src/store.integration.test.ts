import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { DomainEvent } from '@caselens/events';
import { AnalyticsStore, PROJECTION_NAME } from './store.js';

const databaseUrl = process.env.TEST_ANALYTICS_DATABASE_URL;

/**
 * Idempotency is only real against a real transaction. A fake store would dedupe because it was
 * written to dedupe; what has to be proven is that the claim and the projection commit together, so
 * that a projection which fails leaves no record of having succeeded.
 */
describe.skipIf(!databaseUrl)('analytics projection store', () => {
  it('applies an event once however many times it is delivered', async () => {
    const store = new AnalyticsStore(databaseUrl!);
    const sql = postgres(databaseUrl!, { prepare: false });
    const suffix = Date.now().toString(36);
    const event = makeEvent(`evt_dup_${suffix}`, 1_000_001);
    let projected = 0;

    try {
      // Delivery is at-least-once, so this is the normal case, not the exotic one.
      expect(
        await store.apply(event, async () => {
          projected += 1;
        }),
      ).toBe('applied');
      expect(
        await store.apply(event, async () => {
          projected += 1;
        }),
      ).toBe('duplicate');

      // The second delivery was never offered to the projection at all.
      expect(projected).toBe(1);
      expect(
        await sql`select count(*)::int as count from processed_events where event_id = ${event.id}`,
      ).toEqual([{ count: 1 }]);
    } finally {
      await sql`delete from processed_events where event_id = ${event.id}`;
      await sql.end();
      await store.close();
    }
  });

  it('records nothing when the projection fails, so redelivery can still succeed', async () => {
    // The regression this guards: recording the event id and projecting in separate transactions.
    // A crash between them would mark the event processed while nothing was projected, and because
    // the id is already recorded, no redelivery would ever repair it. The fact would be lost
    // silently and permanently.
    const store = new AnalyticsStore(databaseUrl!);
    const sql = postgres(databaseUrl!, { prepare: false });
    const suffix = Date.now().toString(36);
    const event = makeEvent(`evt_fail_${suffix}`, 1_000_002);

    try {
      await expect(
        store.apply(event, async () => {
          throw new Error('projection blew up');
        }),
      ).rejects.toThrow('projection blew up');

      // No claim survived the rollback, so the event is still deliverable.
      expect(
        await sql`select count(*)::int as count from processed_events where event_id = ${event.id}`,
      ).toEqual([{ count: 0 }]);

      let projected = 0;
      expect(
        await store.apply(event, async () => {
          projected += 1;
        }),
      ).toBe('applied');
      expect(projected).toBe(1);
    } finally {
      await sql`delete from processed_events where event_id = ${event.id}`;
      await sql.end();
      await store.close();
    }
  });

  it('never lets the watermark move backwards', async () => {
    // Events are not guaranteed to arrive in order - a redelivery of an older event can follow a
    // newer one. If that dragged `last_sequence` back, consumer lag would read as negative and the
    // number would be worse than useless.
    const store = new AnalyticsStore(databaseUrl!);
    const sql = postgres(databaseUrl!, { prepare: false });
    const suffix = Date.now().toString(36);
    const newer = makeEvent(`evt_new_${suffix}`, 9_000_100);
    const older = makeEvent(`evt_old_${suffix}`, 9_000_001);

    try {
      await store.apply(newer, async () => {});
      expect(await store.lastSequence()).toBe(9_000_100);

      await store.apply(older, async () => {});
      expect(await store.lastSequence()).toBe(9_000_100);
    } finally {
      await sql`delete from processed_events where event_id in (${newer.id}, ${older.id})`;
      await sql`delete from projection_state where name = ${PROJECTION_NAME}`;
      await sql.end();
      await store.close();
    }
  });
});

function makeEvent(id: string, sequence: number): DomainEvent {
  return {
    id,
    type: 'case.created',
    tenantId: 'tenant_demo',
    aggregateType: 'case',
    aggregateId: `case_${id}`,
    occurredAt: '2026-09-09T10:00:00.000Z',
    sequence,
    payload: { reference: 'A-1', domainPackId: 'pack_a', domainPackVersion: '1.0.0' },
  } as DomainEvent;
}
