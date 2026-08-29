import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { PostgresCaseStore, type PersistedCaseProjection } from './case-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgresCaseStore tenant integration', () => {
  it('enforces tenant scope, aggregation, optimistic versions, jobs, and audit privileges', async () => {
    const store = new PostgresCaseStore(databaseUrl!);
    const runtimeSql = postgres(databaseUrl!, { prepare: false });
    const suffix = Date.now().toString(36);
    const tenantA = `tenant_it_a_${suffix}`;
    const tenantB = `tenant_it_b_${suffix}`;
    const caseA = makeCase(`case_it_a_${suffix}`, tenantA, `IT-A-${suffix}`);
    const caseB = makeCase(`case_it_b_${suffix}`, tenantB, `IT-B-${suffix}`);
    try {
      await store.seed(
        [
          { id: tenantA, name: 'Integration Tenant A', domain: 'Commercial contract review' },
          { id: tenantB, name: 'Integration Tenant B', domain: 'Insurance claims assessment' },
        ],
        [
          {
            id: `user_it_a_${suffix}`,
            displayName: 'Tenant A Reviewer',
            email: `a-${suffix}@example.test`,
            tenantIds: [tenantA],
            role: 'admin',
          },
          {
            id: `user_it_b_${suffix}`,
            displayName: 'Tenant B Reviewer',
            email: `b-${suffix}@example.test`,
            tenantIds: [tenantB],
            role: 'admin',
          },
        ],
        [caseA, caseB],
      );

      expect(await store.list({ tenantIds: [tenantA], platformAdmin: false }, {})).toHaveLength(1);
      expect(await store.get({ tenantIds: [tenantA], platformAdmin: false }, caseB.id)).toBeNull();
      const aggregate = await store.list(
        { tenantIds: [tenantA, tenantB], platformAdmin: true },
        {},
      );
      expect(aggregate.some((item) => item.id === caseA.id)).toBe(true);
      expect(aggregate.some((item) => item.id === caseB.id)).toBe(true);

      const current = (await store.get({ tenantIds: [tenantA], platformAdmin: false }, caseA.id))!;
      current.version += 1;
      current.updatedAt = new Date().toISOString();
      await store.save(current, 1);
      await expect(store.save({ ...current, version: 3 }, 1)).rejects.toThrow('VERSION_CONFLICT');

      const [auditPrivileges] = await runtimeSql<
        Array<{ canUpdate: boolean; canDelete: boolean }>
      >`select has_table_privilege(current_user, 'audit_events', 'UPDATE') as "canUpdate",
        has_table_privilege(current_user, 'audit_events', 'DELETE') as "canDelete"`;
      expect(auditPrivileges).toEqual({ canUpdate: false, canDelete: false });

      const first = await store.createJob({
        id: `job_it_${suffix}`,
        tenantId: tenantA,
        caseId: caseA.id,
        status: 'queued',
        progress: 0,
        kind: 'process_case',
        idempotencyKey: `job-key-${suffix}`,
        createdAt: current.updatedAt,
        updatedAt: current.updatedAt,
      });
      const duplicate = await store.createJob({ ...first, id: `job_duplicate_${suffix}` });
      expect(duplicate.id).toBe(first.id);
    } finally {
      try {
        await runtimeSql.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', '', true), set_config('app.platform_admin', 'true', true)`;
          await tx`delete from jobs where id in (${`job_it_${suffix}`}, ${`job_duplicate_${suffix}`})`;
          await tx`delete from cases where id in (${caseA.id}, ${caseB.id})`;
          await tx`delete from memberships where tenant_id in (${tenantA}, ${tenantB})`;
          await tx`delete from domain_packs where tenant_id in (${tenantA}, ${tenantB})`;
          await tx`delete from users where id in (${`user_it_a_${suffix}`}, ${`user_it_b_${suffix}`})`;
          await tx`delete from tenants where id in (${tenantA}, ${tenantB})`;
        });
      } finally {
        try {
          await runtimeSql.end({ timeout: 5 });
        } finally {
          await store.close();
        }
      }
    }
  });
});

function makeCase(id: string, tenantId: string, reference: string): PersistedCaseProjection {
  const now = new Date().toISOString();
  return {
    id,
    tenantId,
    reference,
    subjectName: reference,
    domain: 'Commercial contract review',
    domainPackVersion: '1.0.0',
    status: 'needs_review',
    recommendation: 'request_information',
    progress: 100,
    createdAt: now,
    updatedAt: now,
    dueAt: now,
    assignedTo: 'Integration Reviewer',
    version: 1,
    documents: [],
    facts: [],
    findings: [],
    audit: [],
    decision: null,
  };
}
