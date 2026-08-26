import { describe, expect, it } from 'vitest';
import { pharmacySupplierPack, type DomainPack } from '@caselens/domain';
import {
  CaseWorkflowRunner,
  MemoryWorkflowCheckpointStore,
  type CaseWorkflowState,
  type WorkflowDependencies,
} from '../src/index.js';

const input = { tenantId: 'tenant-a', caseId: 'case-42', idempotencyKey: 'process-v1' };
const citations = [
  {
    chunkId: 'policy-1',
    documentId: 'insurance-policy',
    documentVersion: '2',
    collectionId: 'insurance',
    quote: 'Coverage shall be EUR 2,000,000.',
    score: 0.91,
    tags: ['insurance'],
  },
];

function dependencies(overrides: Partial<WorkflowDependencies> = {}): WorkflowDependencies {
  return {
    pack: pharmacySupplierPack,
    validate: async () => ({ fatalErrors: [], warnings: [] }),
    extract: async () => ({
      facts: {
        supplier: { distributesTemperatureControlled: true },
        insurance: { liabilityLimitEur: 1_000_000 },
        certificates: { iso13485: { validUntil: '2027-12-31' } },
        dpa: { signed: true },
      },
      lowConfidencePaths: [],
      warnings: [],
    }),
    classify: async () => ({
      availableDocumentTypes: [
        'commercial_register',
        'insurance_certificate',
        'iso_13485',
        'data_processing_agreement',
        'supply_contract',
      ],
      reviewReasons: [],
    }),
    reconcile: async () => ({ identityConflict: true, reviewReasons: [] }),
    retrieve: async () => ({ status: 'found', citations }),
    summarize: async (state) => `Advisory only: ${state.findings.length} finding(s).`,
    timeoutMs: 100,
    maxAttempts: 2,
    ...overrides,
  };
}

describe('conditional document review workflow', () => {
  it('produces the deterministic pharmacy result and pauses for review', async () => {
    const result = await new CaseWorkflowRunner(dependencies()).run(input);
    expect(result.state.status).toBe('needs_review');
    expect(result.state.recommendation).toBe('request_information');
    expect(result.state.findings.map((finding) => finding.ruleId)).toEqual([
      'required_document:gdp-for-cold-chain',
      'insurance-minimum',
      'legal-name-conflict',
    ]);
    expect(result.state.citations[0]?.chunkId).toBe('policy-1');
  });

  it('completes a clean dossier and keeps model summary advisory', async () => {
    const runner = new CaseWorkflowRunner(
      dependencies({
        extract: async () => ({
          facts: {
            supplier: { distributesTemperatureControlled: false },
            insurance: { liabilityLimitEur: 2_000_000 },
            certificates: { iso13485: { validUntil: '2027-12-31' } },
            dpa: { signed: true },
          },
          lowConfidencePaths: [],
          warnings: [],
        }),
        classify: async () => ({
          availableDocumentTypes: ['commercial_register', 'insurance_certificate'],
          reviewReasons: [],
        }),
        reconcile: async () => ({ identityConflict: false, reviewReasons: [] }),
      }),
    );
    const result = await runner.run({ ...input, idempotencyKey: 'clean' });
    expect(result.state).toMatchObject({
      status: 'completed',
      recommendation: 'approve',
      advisorySummary: 'Advisory only: 0 finding(s).',
    });
  });

  it('pauses for a major-only finding even when no required document is missing', async () => {
    const runner = new CaseWorkflowRunner(
      dependencies({
        classify: async () => ({
          availableDocumentTypes: [
            'commercial_register',
            'insurance_certificate',
            'iso_13485',
            'data_processing_agreement',
            'supply_contract',
            'gdp_certificate',
          ],
          reviewReasons: [],
        }),
        reconcile: async () => ({ identityConflict: false, reviewReasons: [] }),
      }),
    );
    const result = await runner.run({ ...input, idempotencyKey: 'major-only' });
    expect(result.state.status).toBe('needs_review');
    expect(result.state.reviewReasons).toContain(
      'Material finding: Liability coverage below policy.',
    );
  });

  it.each([
    [
      'low confidence',
      {
        extract: async () => ({
          facts: {
            supplier: { distributesTemperatureControlled: false },
            insurance: { liabilityLimitEur: 2_000_000 },
            dpa: { signed: true },
          },
          lowConfidencePaths: ['insurance.liabilityLimitEur'],
          warnings: [],
        }),
        reconcile: async () => ({ identityConflict: false, reviewReasons: [] }),
      },
    ],
    [
      'ambiguous classification',
      {
        classify: async () => ({
          availableDocumentTypes: ['commercial_register', 'insurance_certificate'],
          reviewReasons: ['Combined document requires split confirmation.'],
        }),
        extract: async () => ({
          facts: {
            supplier: { distributesTemperatureControlled: false },
            insurance: { liabilityLimitEur: 2_000_000 },
            dpa: { signed: true },
          },
          lowConfidencePaths: [],
          warnings: [],
        }),
        reconcile: async () => ({ identityConflict: false, reviewReasons: [] }),
      },
    ],
  ] as const)('pauses on %s', async (_name, overrides) => {
    const result = await new CaseWorkflowRunner(dependencies(overrides)).run({
      ...input,
      idempotencyKey: _name,
    });
    expect(result.state.status).toBe('needs_review');
  });

  it('abstains safely when policy is stale, missing, or the provider is down', async () => {
    const missing = await new CaseWorkflowRunner(
      dependencies({
        retrieve: async () => ({
          status: 'abstained',
          citations: [],
          reason: 'no_in_scope_policy',
        }),
      }),
    ).run({ ...input, idempotencyKey: 'no-policy' });
    expect(missing.state.reviewReasons).toContain(
      'Policy retrieval abstained: no_in_scope_policy.',
    );
    const down = await new CaseWorkflowRunner(
      dependencies({
        retrieve: async () => {
          throw new Error('provider unavailable');
        },
      }),
    ).run({ ...input, idempotencyKey: 'provider-down' });
    expect(down.state.status).toBe('needs_review');
    expect(down.state.attempts.retrieve).toBe(2);
  });

  it('preserves deterministic outcome when advisory model fails', async () => {
    const result = await new CaseWorkflowRunner(
      dependencies({
        extract: async () => ({
          facts: {
            supplier: { distributesTemperatureControlled: false },
            insurance: { liabilityLimitEur: 2_000_000 },
            dpa: { signed: true },
          },
          lowConfidencePaths: [],
          warnings: [],
        }),
        classify: async () => ({
          availableDocumentTypes: ['commercial_register', 'insurance_certificate'],
          reviewReasons: [],
        }),
        reconcile: async () => ({ identityConflict: false, reviewReasons: [] }),
        summarize: async () => {
          throw new Error('model unavailable');
        },
      }),
    ).run({ ...input, idempotencyKey: 'summary-down' });
    expect(result.state).toMatchObject({ status: 'completed', recommendation: 'approve' });
    expect(result.state.advisorySummary).toContain('unavailable');
  });
});

describe('durability, idempotency, cancellation, and human resume', () => {
  it('returns the saved checkpoint after a duplicate job or worker restart', async () => {
    const store = new MemoryWorkflowCheckpointStore();
    const first = await new CaseWorkflowRunner(dependencies(), store).run(input);
    const afterRestart = await new CaseWorkflowRunner(
      dependencies({
        validate: async () => {
          throw new Error('must not rerun');
        },
      }),
      store,
    ).run(input);
    expect(first.duplicate).toBe(false);
    expect(afterRestart.duplicate).toBe(true);
    expect(afterRestart.state).toEqual(first.state);
  });

  it('honors cancellation before work starts', async () => {
    const runner = new CaseWorkflowRunner(dependencies());
    const cancelledInput = { ...input, idempotencyKey: 'cancelled' };
    runner.cancel(cancelledInput);
    expect((await runner.run(cancelledInput)).state.status).toBe('cancelled');
  });

  it('bounds timeouts and records attempts', async () => {
    const runner = new CaseWorkflowRunner(
      dependencies({
        validate: async () => await new Promise(() => undefined),
        timeoutMs: 5,
        maxAttempts: 2,
      }),
    );
    const result = await runner.run({ ...input, idempotencyKey: 'timeout' });
    expect(result.state.status).toBe('failed');
    expect(result.state.attempts.validate).toBe(2);
    expect(result.state.reviewReasons[0]).toContain('timed out');
  });

  it('requires a reason, applies corrections, and re-evaluates on resume', async () => {
    const runner = new CaseWorkflowRunner(
      dependencies({
        extract: async () => ({
          facts: {
            supplier: { distributesTemperatureControlled: false },
            insurance: { liabilityLimitEur: 1_000_000 },
            dpa: { signed: true },
          },
          lowConfidencePaths: ['insurance.liabilityLimitEur'],
          warnings: [],
        }),
        classify: async () => ({
          availableDocumentTypes: ['commercial_register', 'insurance_certificate'],
          reviewReasons: [],
        }),
        reconcile: async () => ({ identityConflict: false, reviewReasons: [] }),
      }),
    );
    const reviewInput = { ...input, idempotencyKey: 'resume' };
    expect((await runner.run(reviewInput)).state.status).toBe('needs_review');
    await expect(
      runner.resume(reviewInput, { action: 'correct', reviewerId: 'reviewer-1', reason: '' }),
    ).rejects.toThrow('reason');
    const resumed = await runner.resume(reviewInput, {
      action: 'correct',
      reviewerId: 'reviewer-1',
      reason: 'Insurance certificate confirmed',
      factCorrections: { insurance: { liabilityLimitEur: 2_000_000 } },
    });
    expect(resumed.revision).toBe(2);
    expect(resumed.state).toMatchObject({ status: 'completed', recommendation: 'approve' });
  });

  it('does not let a reviewer dismiss a still-missing required document', async () => {
    const runner = new CaseWorkflowRunner(dependencies());
    const reviewInput = { ...input, idempotencyKey: 'still-missing' };
    await runner.run(reviewInput);
    const resumed = await runner.resume(reviewInput, {
      action: 'confirm',
      reviewerId: 'reviewer-1',
      reason: 'Reviewed all available documents',
    });
    expect(resumed.state).toMatchObject({
      status: 'needs_review',
      recommendation: 'request_information',
    });
    expect(
      resumed.state.findings.some(
        (finding) => finding.ruleId === 'required_document:gdp-for-cold-chain',
      ),
    ).toBe(true);
  });
});
