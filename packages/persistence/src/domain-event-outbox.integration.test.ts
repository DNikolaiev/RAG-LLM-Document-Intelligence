import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { PostgresCaseStore, type PersistedCaseProjection } from './case-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;

/**
 * The outbox exists to make one guarantee: a domain event and the business change it describes
 * commit together or not at all. That guarantee is only observable against a real transaction, so
 * it cannot be asserted with an in-memory stand-in - a stub would simply agree with whatever the
 * code does, which is exactly how the case API and its declared contract drifted apart for weeks.
 */
describe.skipIf(!databaseUrl || !adminDatabaseUrl)('domain event outbox', () => {
  it('commits the fact with the change, once, and writes nothing when the change fails', async () => {
    const store = new PostgresCaseStore(databaseUrl!);
    const adminSql = postgres(adminDatabaseUrl!, { prepare: false });
    const suffix = Date.now().toString(36);
    const tenantId = `tenant_outbox_${suffix}`;
    const caseId = `case_outbox_${suffix}`;
    const orphanCaseId = `case_orphan_${suffix}`;
    // A tenant that was never created. `cases.tenant_id` and `domain_events.tenant_id` both
    // reference `tenants(id)`, so an insert naming it cannot succeed.
    const missingTenantId = `tenant_missing_${suffix}`;

    const events = async (aggregateId: string) =>
      adminSql<Array<{ id: string; type: string; sequence: string; published_at: string | null }>>`
        select id, type, sequence, published_at from domain_events
        where aggregate_id = ${aggregateId} order by sequence asc`;

    try {
      await store.seed(
        [{ id: tenantId, name: 'Outbox Tenant', domain: 'Commercial contract review' }],
        [],
        [],
      );

      // The change succeeds, so the fact is there beside it.
      expect(await store.insert(makeCase(caseId, tenantId))).toBe(true);
      const created = await events(caseId);
      expect(created).toHaveLength(1);
      expect(created[0]!.type).toBe('case.created');
      // Not yet handed to a broker. `published_at` is the relay's column, nobody else's.
      expect(created[0]!.published_at).toBeNull();

      // Re-inserting the same case conflicts and changes nothing, so it must not produce a second
      // fact either. A duplicate event would be indistinguishable downstream from a real one.
      expect(await store.insert(makeCase(caseId, tenantId))).toBe(false);
      expect(await events(caseId)).toHaveLength(1);

      // The change fails, so no fact may survive. This is the regression guard: moving the append
      // before the insert, or outside the transaction, would leave an event describing a case
      // that does not exist.
      await expect(store.insert(makeCase(orphanCaseId, missingTenantId))).rejects.toThrow();
      expect(await events(orphanCaseId)).toHaveLength(0);
    } finally {
      await adminSql`delete from domain_events where tenant_id = ${tenantId}`;
      await adminSql`delete from audit_events where tenant_id = ${tenantId}`;
      await adminSql`delete from cases where tenant_id = ${tenantId}`;
      await adminSql`delete from domain_packs where tenant_id = ${tenantId}`;
      await adminSql`delete from tenants where id = ${tenantId}`;
      await adminSql.end();
      await store.close();
    }
  });

  it('partitions the backlog between relays instead of handing both the same rows', async () => {
    // Two relay instances is the normal deployment, not an exotic one. A plain SELECT would give
    // both of them the same rows and every event would be published twice; `for update skip
    // locked` turns the read into a claim, and this asserts the claim actually holds. A fake store
    // cannot prove this - the locking is the behaviour, and only a real transaction has it.
    const relayA = new PostgresCaseStore(databaseUrl!);
    const relayB = new PostgresCaseStore(databaseUrl!);
    const adminSql = postgres(adminDatabaseUrl!, { prepare: false });
    const suffix = `${Date.now().toString(36)}c`;
    const tenantId = `tenant_claim_${suffix}`;
    // Other tests and other runs share this database, so assertions are scoped to the events this
    // test created rather than to whatever else happens to be unpublished.
    const mine = new Set<string>();
    const ours = (ids: readonly string[]) => ids.filter((id) => mine.has(id));

    let releaseA: () => void = () => {};
    const aIsHolding = new Promise<void>((resolve) => (releaseA = resolve));
    let announceA: () => void = () => {};
    const aHasClaimed = new Promise<void>((resolve) => (announceA = resolve));

    try {
      await seedTenant(relayA, tenantId);
      for (let index = 0; index < 4; index += 1) {
        await relayA.insert(makeCase(`case_claim_${suffix}_${index}`, tenantId));
      }
      for (const event of await adminSql<Array<{ id: string }>>`
        select id from domain_events where tenant_id = ${tenantId}`) {
        mine.add(event.id);
      }
      expect(mine.size).toBe(4);

      const batchA: string[] = [];
      const batchB: string[] = [];

      // A claims two rows and holds its transaction open, exactly as it would while waiting on a
      // broker confirm.
      const runA = relayA.claimUnpublishedEvents(2, async (events) => {
        batchA.push(...events.map((event) => event.id));
        announceA();
        await aIsHolding;
        return { publishedIds: events.map((event) => event.id) };
      });

      await aHasClaimed;

      // B runs the identical query while A still holds its rows.
      const runB = relayB.claimUnpublishedEvents(2, async (events) => {
        batchB.push(...events.map((event) => event.id));
        return { publishedIds: events.map((event) => event.id) };
      });
      await runB;
      releaseA();
      await runA;

      const mineA = ours(batchA);
      const mineB = ours(batchB);
      expect(mineA).toHaveLength(2);
      expect(mineB).toHaveLength(2);
      // The property that matters: no event reached both relays.
      expect(mineA.filter((id) => mineB.includes(id))).toEqual([]);
      // Between them they took the whole backlog rather than B coming back empty, which is what a
      // naive `LIMIT ... FOR UPDATE SKIP LOCKED` plan shape would produce.
      expect(new Set([...mineA, ...mineB]).size).toBe(4);
    } finally {
      releaseA();
      await adminSql`delete from domain_events where tenant_id = ${tenantId}`;
      await adminSql`delete from audit_events where tenant_id = ${tenantId}`;
      await adminSql`delete from cases where tenant_id = ${tenantId}`;
      await adminSql`delete from domain_packs where tenant_id = ${tenantId}`;
      await adminSql`delete from tenants where id = ${tenantId}`;
      await adminSql.end();
      await relayA.close();
      await relayB.close();
    }
  });
});

async function seedTenant(store: PostgresCaseStore, tenantId: string): Promise<void> {
  await store.seed(
    [{ id: tenantId, name: 'Claim Tenant', domain: 'Commercial contract review' }],
    [],
    [],
  );
}

function makeCase(id: string, tenantId: string): PersistedCaseProjection {
  const now = new Date().toISOString();
  return {
    id,
    tenantId,
    reference: `OUTBOX-${id.slice(-6)}`,
    subjectName: 'Outbox Subject GmbH',
    domain: 'Commercial contract review',
    domainPackVersion: '1.0.0',
    status: 'needs_review',
    recommendation: null,
    progress: 0,
    createdAt: now,
    updatedAt: now,
    dueAt: now,
    assignedTo: 'Outbox Reviewer',
    version: 1,
    documents: [],
    facts: [],
    findings: [],
    audit: [],
    decision: null,
  } as unknown as PersistedCaseProjection;
}
