import { describe, expect, it } from 'vitest';
import { pharmacySupplierPack } from '@caselens/domain';
import {
  DeterministicModelProvider,
  DeterministicOcrProvider,
  DeterministicTextProvider,
} from '@caselens/providers';
import {
  chunkPolicyPages,
  extractPolicyPages,
  generatePolicyProposals,
} from '../src/policy/policy-pipeline.js';

const quote = 'Suppliers shall maintain product liability coverage of at least EUR 2,000,000.';
const tests = [
  {
    kind: 'match',
    name: 'below',
    input: { facts: { insurance: { liabilityLimitEur: 1_000_000 } } },
    expected: true,
  },
  {
    kind: 'no_match',
    name: 'enough',
    input: { facts: { insurance: { liabilityLimitEur: 2_000_000 } } },
    expected: false,
  },
  { kind: 'missing_value', name: 'missing', input: { facts: { insurance: {} } }, expected: false },
  {
    kind: 'boundary',
    name: 'boundary',
    input: { facts: { insurance: { liabilityLimitEur: 1_999_999.99 } } },
    expected: true,
  },
] as const;

describe('policy processing pipeline', () => {
  it('uses OCR for scanned pages and preserves page provenance in chunks', async () => {
    const pages = await extractPolicyPages({
      bytes: new Uint8Array([1]),
      mediaType: 'application/pdf',
      languageHints: ['eng', 'deu'],
      textProvider: new DeterministicTextProvider([
        { page: 1, text: '', rotation: 0, confidence: 0.1 },
        { page: 2, text: `2. INSURANCE\n\n${quote}`, rotation: 0, confidence: 0.98 },
      ]),
      ocrProvider: new DeterministicOcrProvider({
        1: {
          page: 1,
          text: '1. SCOPE\n\nThis policy applies to all suppliers.',
          rotation: 0,
          confidence: 0.91,
        },
      }),
    });
    expect(pages.map((page) => page.extractionMethod)).toEqual(['ocr', 'native']);
    const chunks = chunkPolicyPages('policy_v3', pages, { chunkSize: 120, overlap: 20 });
    expect(
      chunks.some((chunk) => chunk.pageFrom === 2 && chunk.heading?.includes('INSURANCE')),
    ).toBe(true);
  });

  it('creates a cited, tested review proposal and blocks hallucinated quotes', async () => {
    const chunks = [
      {
        id: 'chunk_insurance',
        ordinal: 0,
        pageFrom: 2,
        pageTo: 2,
        heading: 'Insurance',
        headingPath: ['Insurance'],
        content: quote,
        sourceQuote: quote,
        embedding: [1],
        embeddingProvider: 'fixture',
        embeddingModel: 'fixture',
        tags: ['insurance'],
        metadata: {},
      },
    ];
    const response = (citation: string) => ({
      proposals: [
        {
          title: 'Liability coverage below policy',
          description: 'Coverage below the minimum requires a hold.',
          severity: 'major',
          when: {
            operator: 'all',
            conditions: [
              { operator: 'exists', path: 'facts.insurance.liabilityLimitEur', value: true },
              { operator: 'lte', path: 'facts.insurance.liabilityLimitEur', value: 1_999_999.99 },
            ],
          },
          policyTags: ['insurance'],
          citations: [{ chunkId: 'chunk_insurance', page: 2, quote: citation }],
          tests,
          confidence: 0.93,
        },
      ],
    });
    const valid = await generatePolicyProposals({
      policyDocumentId: 'policy_v3',
      uploaderUserId: 'profile_lena_vogt',
      pack: pharmacySupplierPack,
      chunks,
      model: new DeterministicModelProvider({ policy_rule_proposals: response(quote) }),
      modelName: 'fixture-v1',
      timeoutMs: 1_000,
    });
    expect(valid[0]!.proposal).toMatchObject({ status: 'proposed', validationIssues: [] });
    expect(valid[0]!.tests.every((test) => test.actual === test.expected)).toBe(true);

    const invalid = await generatePolicyProposals({
      policyDocumentId: 'policy_v3',
      uploaderUserId: 'profile_lena_vogt',
      pack: pharmacySupplierPack,
      chunks,
      model: new DeterministicModelProvider({
        policy_rule_proposals: response('Invented clause.'),
      }),
      modelName: 'fixture-v1',
      timeoutMs: 1_000,
    });
    expect(invalid[0]!.proposal.status).toBe('invalid');
    expect(invalid[0]!.proposal.validationIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid_citation' })]),
    );
  });
});
