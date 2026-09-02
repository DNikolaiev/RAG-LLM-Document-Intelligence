import {
  ok,
  type ModelProvider,
  type ProviderCapabilities,
  type ProviderResult,
  type StructuredGenerationRequest,
} from '@caselens/providers';

type FixtureDefinition = {
  marker: string;
  title: string;
  description: string;
  severity: 'info' | 'minor' | 'major' | 'critical';
  when: Record<string, unknown>;
  policyTags: string[];
  tests: Array<{ kind: string; name: string; input: Record<string, unknown>; expected: boolean }>;
};

const fixtureDefinitions: readonly FixtureDefinition[] = [
  {
    marker:
      'A commercial contract must be routed for legal review when its governing law is not German law.',
    title: 'Non-German governing law requires legal review',
    description: 'Escalates commercial contracts whose governing law differs from German law.',
    severity: 'major',
    when: {
      operator: 'all',
      conditions: [
        { operator: 'exists', path: 'facts.contract.governingLaw', value: true },
        { operator: 'neq', path: 'facts.contract.governingLaw', value: 'German law' },
      ],
    },
    policyTags: ['commercial-contract', 'governing-law', 'fixture'],
    tests: [
      {
        kind: 'match',
        name: 'English law is escalated',
        input: { facts: { contract: { governingLaw: 'English law' } } },
        expected: true,
      },
      {
        kind: 'no_match',
        name: 'German law is not escalated',
        input: { facts: { contract: { governingLaw: 'German law' } } },
        expected: false,
      },
      {
        kind: 'missing_value',
        name: 'Missing law is not assumed',
        input: { facts: { contract: {} } },
        expected: false,
      },
      {
        kind: 'boundary',
        name: 'German law is the permitted value',
        input: { facts: { contract: { governingLaw: 'German law' } } },
        expected: false,
      },
    ],
  },
  {
    marker:
      'A claim must be routed to senior review when the estimated repair cost is EUR 10,000 or more.',
    title: 'High-value claim requires senior review',
    description: 'Escalates claims at or above the inclusive EUR 10,000 repair-cost threshold.',
    severity: 'major',
    when: { operator: 'gte', path: 'facts.claim.estimatedCostEur', value: 10000 },
    policyTags: ['property-claim', 'senior-review', 'fixture'],
    tests: [
      {
        kind: 'match',
        name: 'EUR 12,000 is escalated',
        input: { facts: { claim: { estimatedCostEur: 12000 } } },
        expected: true,
      },
      {
        kind: 'no_match',
        name: 'EUR 9,999 is not escalated',
        input: { facts: { claim: { estimatedCostEur: 9999 } } },
        expected: false,
      },
      {
        kind: 'missing_value',
        name: 'Missing estimate is not assumed',
        input: { facts: { claim: {} } },
        expected: false,
      },
      {
        kind: 'boundary',
        name: 'EUR 10,000 is escalated',
        input: { facts: { claim: { estimatedCostEur: 10000 } } },
        expected: true,
      },
    ],
  },
  {
    marker:
      'A material certificate must be routed to quality review when the stated material grade is not 1.4404.',
    title: 'Unexpected material grade requires quality review',
    description: 'Escalates material certificates that state a grade other than 1.4404.',
    severity: 'major',
    when: {
      operator: 'all',
      conditions: [
        { operator: 'exists', path: 'facts.material.grade', value: true },
        { operator: 'neq', path: 'facts.material.grade', value: '1.4404' },
      ],
    },
    policyTags: ['supplier-quality', 'material-grade', 'fixture'],
    tests: [
      {
        kind: 'match',
        name: 'Grade 1.4301 is escalated',
        input: { facts: { material: { grade: '1.4301' } } },
        expected: true,
      },
      {
        kind: 'no_match',
        name: 'Grade 1.4404 is not escalated',
        input: { facts: { material: { grade: '1.4404' } } },
        expected: false,
      },
      {
        kind: 'missing_value',
        name: 'Missing grade is not assumed',
        input: { facts: { material: {} } },
        expected: false,
      },
      {
        kind: 'boundary',
        name: 'Grade 1.4404 is the permitted value',
        input: { facts: { material: { grade: '1.4404' } } },
        expected: false,
      },
    ],
  },
];

/**
 * Optional, narrow test-seed adapter. It only replaces policy proposals for the
 * three explicitly marked synthetic PDFs; text extraction, embeddings, storage,
 * review, activation, and case processing still use the configured providers.
 */
export class FixturePolicyModelProvider implements ModelProvider {
  constructor(private readonly delegate: ModelProvider) {}

  capabilities(): ProviderCapabilities {
    return { ...this.delegate.capabilities(), id: 'fixture-policy-catalog' };
  }

  health = () => this.delegate.health();

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<ProviderResult<T>> {
    if (request.schemaName !== 'policy_rule_proposals')
      return this.delegate.generateStructured(request);
    const fixture = fixtureDefinitions.find((candidate) =>
      request.prompt.includes(candidate.marker),
    );
    const citation = fixture ? findCitation(request.prompt, fixture.marker) : null;
    if (!fixture || !citation) return this.delegate.generateStructured(request);
    const response = {
      proposals: [
        {
          title: fixture.title,
          description: fixture.description,
          severity: fixture.severity,
          when: fixture.when,
          policyTags: fixture.policyTags,
          citations: [citation],
          tests: fixture.tests,
          confidence: 0.99,
        },
      ],
    };
    const parsed = request.schema.safeParse(response);
    if (!parsed.success) return this.delegate.generateStructured(request);
    return ok(parsed.data, { providerId: 'fixture-policy-catalog', model: 'fixture-policy-v1' });
  }

  embed(texts: readonly string[]) {
    return this.delegate.embed(texts);
  }
}

function findCitation(
  prompt: string,
  marker: string,
): { chunkId: string; page: number; quote: string } | null {
  const chunks = /<policy-clause chunk-id="([^"]+)" page="(\d+)">\n([\s\S]*?)<\/policy-clause>/g;
  for (const match of prompt.matchAll(chunks)) {
    if (match[3]?.includes(marker)) {
      return { chunkId: match[1]!, page: Number(match[2]), quote: marker };
    }
  }
  return null;
}
