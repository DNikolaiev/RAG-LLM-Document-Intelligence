import { describe, expect, it } from 'vitest';
import { legalContractPack } from '@caselens/domain';
import { DeterministicModelProvider } from '@caselens/providers';
import { FixturePolicyModelProvider } from '../src/fixture-policy-model.js';
import { generatePolicyProposals } from '../src/policy/policy-pipeline.js';

const marker =
  'A commercial contract must be routed for legal review when its governing law is not German law.';

describe('FixturePolicyModelProvider', () => {
  it('returns a fully valid, cited proposal only for a marked synthetic policy', async () => {
    const model = new FixturePolicyModelProvider(new DeterministicModelProvider());
    const proposals = await generatePolicyProposals({
      policyDocumentId: 'policy_fixture_legal',
      uploaderUserId: 'profile_jonas_feld',
      pack: legalContractPack,
      chunks: [
        {
          id: 'chunk_fixture_legal',
          ordinal: 0,
          pageFrom: 1,
          pageTo: 1,
          heading: 'Governing-law escalation',
          headingPath: ['Governing-law escalation'],
          content: marker,
          sourceQuote: marker,
          tags: ['fixture'],
          embedding: [1],
          embeddingProvider: 'fixture',
          embeddingModel: 'fixture',
          metadata: {},
        },
      ],
      model,
      modelName: 'fixture-policy-v1',
      timeoutMs: 1000,
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.proposal.status).toBe('proposed');
    expect(proposals[0]?.proposal.validationIssues).toEqual([]);
    expect(proposals[0]?.tests.map((test) => test.actual)).toEqual([true, false, false, false]);
  });
});
