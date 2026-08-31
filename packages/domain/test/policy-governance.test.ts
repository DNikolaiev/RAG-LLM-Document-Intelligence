import { describe, expect, it } from 'vitest';
import {
  assertPolicyTransition,
  assertProposalTransition,
  pharmacySupplierPack,
  validateRuleProposal,
  type PolicyRuleProposal,
} from '../src/index.js';

function validProposal(): PolicyRuleProposal {
  return {
    id: 'proposal_insurance_minimum_v3',
    title: 'Liability coverage below policy',
    description: 'Coverage must be at least EUR 2,000,000 per occurrence.',
    severity: 'major',
    when: {
      operator: 'all',
      conditions: [
        { operator: 'exists', path: 'facts.insurance.liabilityLimitEur', value: true },
        { operator: 'lte', path: 'facts.insurance.liabilityLimitEur', value: 1_999_999.99 },
      ],
    },
    policyTags: ['insurance', 'coverage'],
    citations: [
      {
        policyVersionId: 'policy_version_risk_3',
        page: 2,
        quote: 'Suppliers shall maintain product liability coverage of at least EUR 2,000,000.',
      },
    ],
    tests: [
      {
        kind: 'match',
        name: 'coverage below threshold',
        input: { facts: { insurance: { liabilityLimitEur: 1_000_000 } } },
        expected: true,
      },
      {
        kind: 'no_match',
        name: 'coverage satisfies threshold',
        input: { facts: { insurance: { liabilityLimitEur: 2_000_000 } } },
        expected: false,
      },
      {
        kind: 'missing_value',
        name: 'coverage absent',
        input: { facts: { insurance: {} } },
        expected: false,
      },
      {
        kind: 'boundary',
        name: 'highest failing amount',
        input: { facts: { insurance: { liabilityLimitEur: 1_999_999.99 } } },
        expected: true,
      },
    ],
    extraction: {
      providerId: 'local-ollama',
      model: 'qwen3:4b',
      promptVersion: 'policy-rule-proposal-v1',
      confidence: 0.91,
    },
    proposedByUserId: 'profile_lena_vogt',
  };
}

describe('policy rule proposal governance', () => {
  it('accepts a cited, typed proposal with passing deterministic tests', () => {
    expect(validateRuleProposal(validProposal(), pharmacySupplierPack)).toEqual({
      valid: true,
      issues: [],
    });
  });

  it('rejects unknown fact paths and incompatible condition values', () => {
    const proposal = validProposal();
    proposal.when = {
      operator: 'all',
      conditions: [
        { operator: 'eq', path: 'facts.unknown.secretLimit', value: true },
        { operator: 'lte', path: 'facts.insurance.liabilityLimitEur', value: 'two million' },
      ],
    };
    const result = validateRuleProposal(proposal, pharmacySupplierPack);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['unknown_fact_path', 'incompatible_value']),
    );
  });

  it('requires source citations and all four deterministic test categories', () => {
    const proposal = validProposal();
    proposal.citations = [];
    proposal.tests = proposal.tests.filter((test) => test.kind === 'match');
    const result = validateRuleProposal(proposal, pharmacySupplierPack);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'citation_required',
        'test_no_match_required',
        'test_missing_value_required',
        'test_boundary_required',
      ]),
    );
  });

  it('executes proposal tests and detects a false expected result', () => {
    const proposal = validProposal();
    proposal.tests[0]!.expected = false;
    const result = validateRuleProposal(proposal, pharmacySupplierPack);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'test_result_mismatch', path: 'tests.0.expected' }),
    );
  });

  it('rejects category labels that do not exercise their intended rule-test scenario', () => {
    const proposal = validProposal();
    proposal.tests[0]!.expected = false;
    proposal.tests[1]!.expected = true;
    proposal.tests[2]!.input = {
      facts: { insurance: { liabilityLimitEur: 2_000_000 } },
    };
    proposal.tests[3]!.input = {
      facts: { insurance: { liabilityLimitEur: 2_000_000 } },
    };

    const result = validateRuleProposal(proposal, pharmacySupplierPack);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'test_match_expected_true',
        'test_no_match_expected_false',
        'test_missing_value_input',
        'test_boundary_input',
      ]),
    );
  });

  it('blocks self-approval unless the local-demo exception is explicitly enabled', () => {
    const proposal = validProposal();
    expect(
      validateRuleProposal(proposal, pharmacySupplierPack, {
        approverUserId: proposal.proposedByUserId!,
        allowSelfApproval: false,
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'self_approval_forbidden' }));
    expect(
      validateRuleProposal(proposal, pharmacySupplierPack, {
        approverUserId: proposal.proposedByUserId!,
        allowSelfApproval: true,
      }).valid,
    ).toBe(true);
  });

  it('enforces explicit policy-version and rule-proposal transition graphs', () => {
    expect(() => assertPolicyTransition('uploaded', 'processing')).not.toThrow();
    expect(() => assertPolicyTransition('failed', 'processing')).not.toThrow();
    expect(() => assertPolicyTransition('active', 'draft')).toThrow(/active.*draft/i);
    expect(() => assertProposalTransition('proposed', 'under_review')).not.toThrow();
    expect(() => assertProposalTransition('invalid', 'rejected')).not.toThrow();
    expect(() => assertProposalTransition('invalid', 'approved')).toThrow(/invalid.*approved/i);
    expect(() => assertProposalTransition('activated', 'rejected')).toThrow(/activated.*rejected/i);
  });
});
