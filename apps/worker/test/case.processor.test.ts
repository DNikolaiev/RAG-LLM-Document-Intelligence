import { describe, expect, it } from 'vitest';
import { CaseProcessor, DeterministicWorkflowRunner } from '../src/case.processor.js';

describe('CaseProcessor', () => {
  it('resumes checkpoints and returns the deterministic review outcome', async () => {
    const processor = new CaseProcessor(new DeterministicWorkflowRunner());
    await expect(
      processor.process({
        id: 'job_1',
        tenantId: 'tenant_a',
        caseId: 'case_1',
        idempotencyKey: 'key_1',
        attempt: 2,
        checkpoint: { completedSteps: ['validate', 'extract'] },
      }),
    ).resolves.toMatchObject({
      status: 'needs_review',
      recommendation: 'request_information',
      completedSteps: ['validate', 'extract', 'classify', 'reconcile', 'retrieve', 'evaluate'],
    });
  });

  it('does not execute duplicate idempotency keys twice', async () => {
    const runner = new DeterministicWorkflowRunner();
    const processor = new CaseProcessor(runner);
    const first = await processor.process({
      id: 'job_1',
      tenantId: 'tenant_a',
      caseId: 'case_1',
      idempotencyKey: 'same',
      attempt: 1,
    });
    const second = await processor.process({
      id: 'job_2',
      tenantId: 'tenant_a',
      caseId: 'case_1',
      idempotencyKey: 'same',
      attempt: 2,
    });
    expect(second).toEqual(first);
  });
});
