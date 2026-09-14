import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PostgresCaseStore } from './case-store.js';
import { PostgresPolicyStore } from './policy-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;

describe.skipIf(!databaseUrl || !adminDatabaseUrl)('policies awaiting a collection', () => {
  it('stores an unfiled policy only while nothing governed depends on it', async () => {
    const cases = new PostgresCaseStore(databaseUrl!);
    const policies = new PostgresPolicyStore(databaseUrl!);
    const sql = postgres(adminDatabaseUrl!, { prepare: false });
    const suffix = Date.now().toString(36);
    const tenantId = `tenant_unfiled_it_${suffix}`;
    const userId = `user_unfiled_it_${suffix}`;
    const scope = { tenantIds: [tenantId], platformAdmin: false };
    const upload = {
      tenantId,
      domainPackId: `pack_${tenantId}`,
      title: 'Anti-bribery policy',
      policyVersion: '2026.1',
      storageKey: `${tenantId}/policies/anti-bribery.pdf`,
      originalName: 'anti-bribery.pdf',
      mediaType: 'application/pdf',
      sha256: 'c'.repeat(64),
      byteSize: 1024,
      pageCount: 1,
      language: 'en',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
      uploadedByUserId: userId,
    };
    const firstId = `policy_unfiled_a_${suffix}`;
    const asAdmin = (statement: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      sql.begin(async (tx) => {
        await tx`select set_config('app.platform_admin', 'true', true)`;
        await statement(tx);
      });
    const violatedConstraint = async (
      statement: (tx: postgres.TransactionSql) => Promise<unknown>,
    ) => {
      try {
        await asAdmin(statement);
        return null;
      } catch (error) {
        return (error as { constraint_name?: string }).constraint_name ?? String(error);
      }
    };

    try {
      await cases.seed(
        [{ id: tenantId, name: 'Unfiled Policy Tenant', domain: 'Commercial contract review' }],
        [
          {
            id: userId,
            displayName: 'Unfiled Administrator',
            email: `${suffix}@example.test`,
            tenantIds: [tenantId],
            role: 'admin',
          },
        ],
        [],
      );

      const unfiled = await policies.create({ ...upload, id: firstId, collectionId: null });
      expect(unfiled).toMatchObject({
        collectionId: null,
        collectionSuggestion: null,
        status: 'uploaded',
      });

      // NULL is not a loophole in the title-and-version uniqueness: the index is NULLS NOT DISTINCT.
      await expect(
        policies.create({ ...upload, id: `policy_unfiled_b_${suffix}`, collectionId: null }),
      ).rejects.toMatchObject({ code: '23505' });

      // Waiting for an administrator, with the suggestion that explains why.
      const suggestion = {
        decision: 'new',
        label: 'Anti-Bribery',
        rationale:
          'The document governs gifts and payments to officials; no collection covers that.',
        nearestCollectionId: null,
        confidence: 0.64,
        evidence: { quote: 'No employee may offer or accept a payment', page: 1 },
        disposition: 'decision_required',
        reasons: ['new_collection'],
        providerId: 'deterministic',
        model: 'fixture-classifier',
        packVersion: '1.1.0',
        classifiedAt: '2026-09-14T10:00:00.000Z',
      };
      await asAdmin(
        (tx) => tx`update policy_documents
          set status = 'awaiting_collection', collection_suggestion = ${tx.json(suggestion)}::jsonb
          where id = ${firstId}`,
      );
      expect(await policies.get(scope, firstId)).toMatchObject({
        status: 'awaiting_collection',
        collectionId: null,
        collectionSuggestion: suggestion,
      });

      // The database refuses what no code path should do: govern an unfiled policy, wait while
      // filed, or store a suggestion that is not an object.
      for (const status of ['under_review', 'approved', 'active']) {
        expect(
          await violatedConstraint(
            (tx) => tx`update policy_documents set status = ${status} where id = ${firstId}`,
          ),
          status,
        ).toBe('policy_documents_collection_filed_check');
      }
      expect(
        await violatedConstraint(
          (tx) => tx`update policy_documents set collection_id = 'term-termination'
            where id = ${firstId}`,
        ),
      ).toBe('policy_documents_awaiting_unfiled_check');
      expect(
        await violatedConstraint(
          (tx) => tx`update policy_documents set collection_suggestion = '[]'::jsonb
            where id = ${firstId}`,
        ),
      ).toBe('policy_documents_collection_suggestion_check');

      // A stored suggestion that no longer matches the contract is surfaced, not shown.
      await asAdmin(
        (tx) => tx`update policy_documents
          set collection_suggestion = ${tx.json({ decision: 'existing' })}::jsonb
          where id = ${firstId}`,
      );
      await expect(policies.get(scope, firstId)).rejects.toThrow(
        `POLICY_COLLECTION_SUGGESTION_INVALID:${firstId}`,
      );

      // Filing it is an ordinary state change once a collection is set.
      await asAdmin(
        (tx) => tx`update policy_documents
          set status = 'processing', collection_id = 'term-termination',
              collection_suggestion = ${tx.json(suggestion)}::jsonb
          where id = ${firstId}`,
      );
      expect(await policies.get(scope, firstId)).toMatchObject({
        status: 'processing',
        collectionId: 'term-termination',
      });

      // The worker's path: updateStatus writes the collection and the suggestion.
      const current = (await policies.get(scope, firstId))!;
      const cleared = await policies.updateStatus({
        tenantId,
        id: firstId,
        expectedVersion: current.version,
        status: 'processing',
        collectionSuggestion: null,
      });
      expect(cleared).toMatchObject({
        collectionId: 'term-termination',
        collectionSuggestion: null,
      });
      // SQL NULL, not the JSON value null - which the object CHECK would refuse.
      const stored = await sql<Array<{ is_sql_null: boolean }>>`
        select collection_suggestion is null as is_sql_null from policy_documents
        where id = ${firstId}`;
      expect(stored[0]?.is_sql_null).toBe(true);
      await expect(
        policies.updateStatus({
          tenantId,
          id: firstId,
          expectedVersion: cleared.version,
          status: 'processing',
          collectionSuggestion: { decision: 'existing' } as never,
        }),
      ).rejects.toThrow();
      const refiled = await policies.updateStatus({
        tenantId,
        id: firstId,
        expectedVersion: cleared.version,
        status: 'processing',
        collectionId: 'liability-indemnity',
        collectionSuggestion: suggestion as never,
      });
      expect(refiled).toMatchObject({
        collectionId: 'liability-indemnity',
        collectionSuggestion: suggestion,
      });
    } finally {
      try {
        await asAdmin(async (tx) => {
          await tx`delete from policy_documents where tenant_id = ${tenantId}`;
          await tx`delete from audit_events where tenant_id = ${tenantId}`;
          await tx`delete from memberships where tenant_id = ${tenantId}`;
          await tx`delete from domain_packs where tenant_id = ${tenantId}`;
          await tx`delete from users where id = ${userId}`;
          await tx`delete from tenants where id = ${tenantId}`;
        });
      } finally {
        await Promise.all([sql.end({ timeout: 5 }), policies.close(), cases.close()]);
      }
    }
  });

  it('files a waiting policy once, with its audit event, and finds the job paused for it', async () => {
    const cases = new PostgresCaseStore(databaseUrl!);
    const policies = new PostgresPolicyStore(databaseUrl!);
    const sql = postgres(adminDatabaseUrl!, { prepare: false });
    const suffix = Date.now().toString(36);
    const tenantId = `tenant_decide_it_${suffix}`;
    const userId = `user_decide_it_${suffix}`;
    const policyId = `policy_decide_it_${suffix}`;
    const jobId = `job_decide_it_${suffix}`;
    const scope = { tenantIds: [tenantId], platformAdmin: false };
    const asAdmin = (statement: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      sql.begin(async (tx) => {
        await tx`select set_config('app.platform_admin', 'true', true)`;
        await statement(tx);
      });

    try {
      await cases.seed(
        [{ id: tenantId, name: 'Decision Tenant', domain: 'Commercial contract review' }],
        [
          {
            id: userId,
            displayName: 'Deciding Administrator',
            email: `${suffix}@example.test`,
            tenantIds: [tenantId],
            role: 'admin',
          },
        ],
        [],
      );
      await policies.create({
        id: policyId,
        tenantId,
        domainPackId: `pack_${tenantId}`,
        title: 'Contract exit policy',
        policyVersion: '2026.1',
        collectionId: null,
        storageKey: `${tenantId}/policies/exit.pdf`,
        originalName: 'exit.pdf',
        mediaType: 'application/pdf',
        sha256: 'e'.repeat(64),
        byteSize: 512,
        pageCount: 1,
        language: 'en',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
        uploadedByUserId: userId,
      });
      await asAdmin(
        (tx) =>
          tx`update policy_documents set status = 'awaiting_collection' where id = ${policyId}`,
      );
      const waitingPolicy = (await policies.get(scope, policyId))!;

      const now = new Date().toISOString();
      await cases.createJob({
        id: jobId,
        tenantId,
        caseId: null,
        targetType: 'policy_version',
        targetId: policyId,
        enqueuedByUserId: userId,
        correlationId: `cor-${suffix}`,
        queueJobId: null,
        status: 'queued',
        progress: 0,
        attempts: 0,
        errorCode: null,
        kind: 'process_policy',
        idempotencyKey: `decide-${suffix}`,
        createdAt: now,
        updatedAt: now,
      });
      expect(await cases.findPausedJob(tenantId, 'policy_version', policyId)).toBeNull();
      await cases.updateJob(jobId, tenantId, {
        status: 'paused',
        progress: 30,
        eventType: 'policy.collection_decision_required',
        stage: 'collection_classification',
        message: 'Choose or create its collection to continue.',
      });
      expect((await cases.findPausedJob(tenantId, 'policy_version', policyId))?.id).toBe(jobId);

      const filed = await policies.fileCollection({
        tenantId,
        id: policyId,
        expectedVersion: waitingPolicy.version,
        collectionId: 'term-termination',
        actorUserId: userId,
        correlationId: `cor-decide-${suffix}`,
        details: { collectionId: 'term-termination', followedSuggestion: null },
      });
      expect(filed).toMatchObject({
        status: 'processing',
        collectionId: 'term-termination',
        version: waitingPolicy.version + 1,
      });
      const audit = await sql<Array<{ action: string; actor_id: string; details: unknown }>>`
        select action, actor_id, details from audit_events
        where tenant_id = ${tenantId} and resource_id = ${policyId}`;
      expect(audit).toEqual([
        {
          action: 'policy.collection_decided',
          actor_id: userId,
          details: { collectionId: 'term-termination', followedSuggestion: null },
        },
      ]);

      // Only once: the policy is no longer waiting, whatever version the caller holds.
      await expect(
        policies.fileCollection({
          tenantId,
          id: policyId,
          expectedVersion: filed.version,
          collectionId: 'liability-indemnity',
          actorUserId: userId,
          correlationId: `cor-decide-again-${suffix}`,
          details: {},
        }),
      ).rejects.toThrow(`POLICY_COLLECTION_STATE_CONFLICT:${policyId}`);

      await cases.updateJob(jobId, tenantId, {
        status: 'queued',
        progress: 30,
        eventType: 'queue.enqueued',
        message: 'Filed into Term and Termination by an administrator; processing resumes.',
      });
      expect(await cases.findPausedJob(tenantId, 'policy_version', policyId)).toBeNull();
    } finally {
      try {
        await asAdmin(async (tx) => {
          await tx`delete from job_events where tenant_id = ${tenantId}`;
          await tx`delete from jobs where tenant_id = ${tenantId}`;
          await tx`delete from policy_documents where tenant_id = ${tenantId}`;
          await tx`delete from audit_events where tenant_id = ${tenantId}`;
          await tx`delete from memberships where tenant_id = ${tenantId}`;
          await tx`delete from domain_packs where tenant_id = ${tenantId}`;
          await tx`delete from users where id = ${userId}`;
          await tx`delete from tenants where id = ${tenantId}`;
        });
      } finally {
        await Promise.all([sql.end({ timeout: 5 }), policies.close(), cases.close()]);
      }
    }
  });
});
