import { describe, expect, it } from 'vitest';
import { pharmacySupplierPack, type Condition } from '@caselens/domain';
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

  it('compiles an existence-only minimum-cover proposal into a numeric boundary rule', async () => {
    const chunks = [
      {
        id: 'chunk_minimum_cover',
        ordinal: 0,
        pageFrom: 1,
        pageTo: 1,
        heading: 'Minimum cover',
        headingPath: ['Minimum cover'],
        content: quote,
        sourceQuote: quote,
        embedding: [1],
        embeddingProvider: 'fixture',
        embeddingModel: 'fixture',
        tags: ['insurance'],
        metadata: {},
      },
    ];
    const proposals = await generatePolicyProposals({
      policyDocumentId: 'policy_minimum_cover',
      uploaderUserId: 'profile_lena_vogt',
      pack: pharmacySupplierPack,
      chunks,
      model: new DeterministicModelProvider({
        policy_rule_proposals: {
          proposals: [
            {
              title: 'Minimum liability cover',
              description: 'Coverage must meet the policy minimum.',
              severity: 'major',
              when: {
                operator: 'exists',
                path: 'facts.insurance.liabilityLimitEur',
                value: true,
              },
              policyTags: ['insurance'],
              citations: [{ chunkId: 'chunk_minimum_cover', page: 1, quote }],
              confidence: 0.94,
            },
          ],
        },
      }),
      modelName: 'fixture-v1',
      timeoutMs: 1_000,
    });

    expect(proposals[0]!.proposal.status).toBe('proposed');
    expect(proposals[0]!.proposal.condition).toMatchObject({
      operator: 'all',
      conditions: expect.arrayContaining([
        expect.objectContaining({
          operator: 'lte',
          path: 'facts.insurance.liabilityLimitEur',
          value: 1_999_999.99,
        }),
      ]),
    });
    expect(proposals[0]!.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'match',
          input: { facts: { insurance: { liabilityLimitEur: 1_999_999.99 } } },
          expected: true,
          actual: true,
        }),
        expect.objectContaining({
          kind: 'no_match',
          input: { facts: { insurance: { liabilityLimitEur: 2_000_000 } } },
          expected: false,
          actual: false,
        }),
      ]),
    );
  });

  it('derives four deterministic tests for every supported condition shape', async () => {
    const genericQuotes = [
      'A signed data processing agreement is required.',
      'The ISO 13485 certificate is valid until 2026-08-26.',
      'A signed data processing agreement and product liability cover are required.',
    ];
    const chunks = [
      {
        id: 'chunk_generic_conditions',
        ordinal: 0,
        pageFrom: 1,
        pageTo: 1,
        heading: 'Conditions',
        headingPath: ['Conditions'],
        content: genericQuotes.join('\n\n'),
        sourceQuote: genericQuotes.join('\n\n'),
        embedding: [1],
        embeddingProvider: 'fixture',
        embeddingModel: 'fixture',
        tags: ['conditions'],
        metadata: {},
      },
    ];
    const scenarios: Array<{ title: string; when: Condition; quote: string }> = [
      {
        title: 'Missing signed DPA',
        when: { operator: 'exists', path: 'facts.dpa.signed', value: false },
        quote: genericQuotes[0]!,
      },
      {
        title: 'Unsigned DPA',
        when: { operator: 'eq', path: 'facts.dpa.signed', value: false },
        quote: genericQuotes[0]!,
      },
      {
        title: 'Expired quality certificate',
        when: {
          operator: 'before',
          path: 'facts.certificates.iso13485.validUntil',
          value: '2026-08-26',
        },
        quote: genericQuotes[1]!,
      },
      {
        title: 'Escalation combination',
        when: {
          operator: 'any',
          conditions: [
            { operator: 'eq', path: 'facts.dpa.signed', value: false },
            { operator: 'lte', path: 'facts.insurance.liabilityLimitEur', value: 1_999_999.99 },
          ],
        },
        quote: genericQuotes[2]!,
      },
    ];

    for (const scenario of scenarios) {
      const proposals = await generatePolicyProposals({
        policyDocumentId: `policy_${scenario.title.replaceAll(' ', '_')}`,
        uploaderUserId: 'profile_lena_vogt',
        pack: pharmacySupplierPack,
        chunks,
        model: new DeterministicModelProvider({
          policy_rule_proposals: {
            proposals: [
              {
                title: scenario.title,
                description: 'A deterministic rule proposal used to exercise the condition engine.',
                severity: 'major',
                when: scenario.when,
                policyTags: ['test'],
                citations: [
                  { chunkId: 'chunk_generic_conditions', page: 1, quote: scenario.quote },
                ],
                confidence: 0.9,
              },
            ],
          },
        }),
        modelName: 'fixture-v1',
        timeoutMs: 1_000,
      });

      expect(proposals[0]!.proposal).toMatchObject({ status: 'proposed', validationIssues: [] });
      expect(proposals[0]!.tests).toHaveLength(4);
      expect(proposals[0]!.tests.map((test) => test.kind).sort()).toEqual([
        'boundary',
        'match',
        'missing_value',
        'no_match',
      ]);
      expect(proposals[0]!.tests.every((test) => test.actual === test.expected)).toBe(true);
    }
  });

  it('blocks a condition on the wrong field and accepts a grounded identity conflict rule', async () => {
    const nameQuote =
      'The insured legal entity must match the approved supplier or a documented group policy must explicitly extend cover to that entity.';
    const chunks = [
      {
        id: 'chunk_name_matching',
        ordinal: 0,
        pageFrom: 2,
        pageTo: 2,
        heading: 'Name matching',
        headingPath: ['Name matching'],
        content: nameQuote,
        sourceQuote: nameQuote,
        embedding: [1],
        embeddingProvider: 'fixture',
        embeddingModel: 'fixture',
        tags: ['identity'],
        metadata: {},
      },
    ];
    const proposals = await generatePolicyProposals({
      policyDocumentId: 'policy_name_matching',
      uploaderUserId: 'profile_lena_vogt',
      pack: pharmacySupplierPack,
      chunks,
      model: new DeterministicModelProvider({
        policy_rule_proposals: {
          proposals: [
            {
              title: 'Incorrect certificate check',
              description:
                'This proposal intentionally uses a field unrelated to the cited clause.',
              severity: 'major',
              when: {
                operator: 'exists',
                path: 'facts.certificates.iso13485.validUntil',
                value: true,
              },
              policyTags: ['identity'],
              citations: [{ chunkId: 'chunk_name_matching', page: 2, quote: nameQuote }],
              confidence: 0.8,
            },
            {
              title: 'Insured legal entity mismatch',
              description: 'Escalate when the insurer names a different legal entity.',
              severity: 'major',
              when: {
                operator: 'exists',
                path: 'reconciliation.supplierLegalNameConflict',
                value: true,
              },
              policyTags: ['identity'],
              citations: [{ chunkId: 'model-returned-wrong-id', page: 2, quote: nameQuote }],
              confidence: 0.91,
            },
          ],
        },
      }),
      modelName: 'fixture-v1',
      timeoutMs: 1_000,
    });

    expect(proposals[0]!.proposal.status).toBe('invalid');
    expect(proposals[0]!.proposal.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'citation_condition_mismatch' }),
        expect.objectContaining({ code: 'condition_too_weak' }),
      ]),
    );
    expect(proposals[1]!.proposal).toMatchObject({ status: 'proposed', validationIssues: [] });
    expect(proposals[1]!.proposal.condition).toEqual({
      operator: 'eq',
      path: 'reconciliation.supplierLegalNameConflict',
      value: true,
    });
    expect(proposals[1]!.citations[0]!.policyChunkId).toBe('chunk_name_matching');
    expect(proposals[1]!.tests).toHaveLength(4);
    expect(proposals[1]!.tests.every((test) => test.actual === test.expected)).toBe(true);
  });
});
