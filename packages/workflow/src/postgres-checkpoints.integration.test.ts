import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PostgresWorkflowCheckpointStore } from './postgres-checkpoints.js';
import type { CaseWorkflowState } from './state.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgresWorkflowCheckpointStore tenant integration', () => {
  it('isolates equal checkpoint keys by tenant and enforces revisions', async () => {
    const suffix = Date.now().toString(36);
    const tenantA = `tenant_checkpoint_a_${suffix}`;
    const tenantB = `tenant_checkpoint_b_${suffix}`;
    const admin = postgres(databaseUrl!, { prepare: false });
    await admin`insert into tenants (id, name) values (${tenantA}, 'Checkpoint A'), (${tenantB}, 'Checkpoint B')`;
    const first = new PostgresWorkflowCheckpointStore(databaseUrl!, tenantA);
    const second = new PostgresWorkflowCheckpointStore(databaseUrl!, tenantB);
    try {
      const state = makeState(tenantA);
      const base = {
        key: 'shared-key',
        state,
        updatedAt: new Date().toISOString(),
        revision: 1,
      };
      await first.save(base, null);
      await second.save({ ...base, state: makeState(tenantB) }, null);
      const firstCheckpoint = await first.get('shared-key');
      expect(firstCheckpoint?.state.tenantId).toBe(tenantA);
      expect(firstCheckpoint?.state.factEvidence['contract.governingLaw']).toMatchObject({
        documentId: 'document-1',
        page: 3,
        confidence: 0.93,
      });
      expect(firstCheckpoint?.state.documentClassifications[0]).toMatchObject({
        documentId: 'document-1',
        typeId: 'commercial_contract',
      });
      expect((await second.get('shared-key'))?.state.tenantId).toBe(tenantB);
      await expect(first.save({ ...base, revision: 2 }, 99)).rejects.toThrow('Checkpoint conflict');
    } finally {
      await first.close();
      await second.close();
      await admin.end({ timeout: 5 });
    }
  });
});

function makeState(tenantId: string): CaseWorkflowState {
  return {
    tenantId,
    caseId: 'case-checkpoint-integration',
    idempotencyKey: 'checkpoint-integration',
    status: 'running',
    phase: 'queued',
    facts: {},
    factEvidence: {
      'contract.governingLaw': {
        documentId: 'document-1',
        page: 3,
        quote: 'This agreement is governed by German law.',
        confidence: 0.93,
      },
    },
    availableDocumentTypes: ['commercial_contract'],
    documentClassifications: [
      {
        documentId: 'document-1',
        typeId: 'commercial_contract',
        confidence: 0.97,
        page: 1,
        quote: 'Commercial Services Agreement',
      },
    ],
    lowConfidencePaths: [],
    identityConflict: false,
    retrievalStatus: 'pending',
    citations: [],
    findings: [],
    reviewReasons: [],
    warnings: [],
    recommendation: null,
    advisorySummary: null,
    attempts: {},
    humanReview: null,
  };
}
