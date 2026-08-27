import { describe, expect, it } from 'vitest';
import { CasesService } from '../src/cases.service.js';
import type { RequestContext } from '../src/request-context.js';

const context: RequestContext = {
  profileId: 'profile_lena_vogt',
  tenantId: 'tenant_demo',
  tenantIds: ['tenant_demo'],
  userId: 'reviewer_1',
  role: 'reviewer',
  platformAdmin: false,
  correlationId: 'cor_test',
};

describe('CasesService', () => {
  it('does not leak cases across tenants', () => {
    const service = new CasesService();
    expect(service.list('tenant_other').items).toEqual([]);
  });

  it('makes processing idempotent', () => {
    const service = new CasesService();
    const first = service.process(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', 'same-key');
    const second = service.process(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', 'same-key');
    expect(second).toEqual(first);
  });

  it('scopes processing idempotency keys to the case', () => {
    const service = new CasesService();
    const first = service.process(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', 'shared-key');
    const second = service.process(context, 'case_01J67Y7HFXCQ1D78Y09N8ZABPV', 'shared-key');
    expect(second).not.toEqual(first);
  });

  it('requires a correction reason and optimistic version through the service invariant', () => {
    const service = new CasesService();
    const corrected = service.correctFact(
      context,
      'case_01J67X4Q7B5E6QG4S9CY0F7R2K',
      'fact_contract_party',
      {
        value: 'MediSupply GmbH',
        reason: 'Verified against a signed amendment',
        version: 1,
      },
    );
    expect(corrected).toMatchObject({
      value: 'MediSupply GmbH',
      reviewStatus: 'corrected',
      version: 2,
    });
    expect(() =>
      service.correctFact(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', 'fact_contract_party', {
        value: 'x',
        reason: 'stale update',
        version: 1,
      }),
    ).toThrow(/version 2/i);
  });

  it('reserves final decisions for approvers', () => {
    const service = new CasesService();
    expect(() =>
      service.decide(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', {
        outcome: 'approve',
        reason: 'All requirements are satisfied.',
        version: 3,
      }),
    ).toThrow(/approver/i);
  });

  it('prevents approvers from bypassing deterministic material findings', () => {
    const service = new CasesService();
    expect(() =>
      service.decide({ ...context, role: 'approver' }, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', {
        outcome: 'approve',
        reason: 'Reviewer override was requested for the remaining findings.',
        version: 3,
      }),
    ).toThrow(/material findings/i);
  });

  it('counts only open findings in queue summaries', () => {
    const service = new CasesService();
    service.resolveFinding(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', 'finding_gdp', {
      status: 'resolved',
      reason: 'A current certificate was supplied.',
      version: 1,
    });

    const summary = service
      .list('tenant_demo')
      .items.find((item) => item.id === 'case_01J67X4Q7B5E6QG4S9CY0F7R2K');
    expect(summary?.findingCounts).toEqual({ major: 2 });
  });
});
