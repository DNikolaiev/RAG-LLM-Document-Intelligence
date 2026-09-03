import { describe, expect, it } from 'vitest';
import { parseDomainPack, pharmacySupplierPack, type DomainPack } from '@caselens/domain';
import type { StoredPolicyChunk } from '@caselens/persistence';
import {
  DeterministicModelProvider,
  type ModelProvider,
  type ProviderCapabilities,
  type ProviderResult,
  type StructuredGenerationRequest,
} from '@caselens/providers';
import {
  DEFAULT_FIELD_SIMILARITY_FLOOR,
  FIELD_DEDUP_CANDIDATE_LIMIT,
  generateFieldProposals,
  syncFieldEmbeddingIndex,
  type FieldDictionaryStore,
  type FieldEmbeddingRow,
  type SimilarFieldMatch,
} from '../src/policy/field-proposal-pipeline.js';

const excessQuote = 'The insurer shall apply a policy excess of no more than EUR 5,000 per claim.';
const coverQuote = 'Cover amount must be at least EUR 2,000,000 for product liability.';
const limitQuote = 'The liability limit must be recorded on every certificate.';
const endDateQuote = 'The cover end date must be recorded for every liability policy.';
const coverageQuote = 'The coverage recorded on the certificate must match the approved supplier.';
const coverageAmountQuote =
  'The coverage amount for product liability must be at least EUR 2,000,000.';

/** Every distinct field path the compiled pharmacy pack declares; none of them was ever proposed. */
const packFieldPaths = [
  ...new Set(
    pharmacySupplierPack.documentTypes.flatMap((documentType) =>
      documentType.extractionFields.map((field) => field.path),
    ),
  ),
];

const chunk: StoredPolicyChunk = {
  id: 'chunk_policy',
  ordinal: 0,
  pageFrom: 1,
  pageTo: 1,
  heading: 'Insurance',
  headingPath: ['Insurance'],
  content: [
    excessQuote,
    coverQuote,
    limitQuote,
    endDateQuote,
    coverageQuote,
    coverageAmountQuote,
  ].join(' '),
  sourceQuote: excessQuote,
  embedding: [1],
  embeddingProvider: 'fixture',
  embeddingModel: 'fixture',
  tags: ['insurance'],
  metadata: {},
};

interface GeneratedCandidate {
  documentTypeId: string;
  path: string;
  label: string;
  fieldType: string;
  aliases: string[];
  citation: { chunkId: string; page: number; quote: string };
}

function candidate(overrides: Partial<GeneratedCandidate> = {}): GeneratedCandidate {
  return {
    documentTypeId: 'insurance_certificate',
    path: 'insurance.excessEur',
    label: 'Policy excess',
    fieldType: 'currency',
    aliases: ['deductible'],
    citation: { chunkId: 'chunk_policy', page: 1, quote: excessQuote },
    ...overrides,
  };
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((total, value, index) => total + value * (right[index] ?? 0), 0);
  const magnitude = Math.hypot(...left) * Math.hypot(...right);
  return magnitude === 0 ? 0 : Math.max(0, dot / magnitude);
}

/**
 * Stands in for the Track A persistence surface; records every call so the ladder can be asserted.
 * Recall is served from the in-memory embedding index, exactly as the store serves it from
 * `field_embeddings`, unless a test pins `matches` to assert a particular similarity.
 */
class StubFieldDictionaryStore implements FieldDictionaryStore {
  readonly packCalls: Array<{ tenantId: string; domainPackId: string }> = [];
  readonly searchCalls: Array<{
    tenantId: string;
    domainPackId: string;
    embedding: number[];
    limit: number;
  }> = [];
  readonly fingerprintCalls: Array<{ tenantId: string; domainPackId: string }> = [];
  readonly upsertCalls: FieldEmbeddingRow[][] = [];
  readonly #index = new Map<string, FieldEmbeddingRow>();

  constructor(
    private readonly options: {
      pack?: DomainPack | null;
      matches?: readonly SimilarFieldMatch[];
    } = {},
  ) {}

  get indexedPaths(): string[] {
    return [...this.#index.keys()].sort();
  }

  async getActivePackDefinition(
    tenantId: string,
    domainPackId: string,
  ): Promise<DomainPack | null> {
    this.packCalls.push({ tenantId, domainPackId });
    return this.options.pack ?? null;
  }

  async listFieldEmbeddingFingerprints(
    tenantId: string,
    domainPackId: string,
  ): Promise<ReadonlyArray<{ path: string; fingerprint: string }>> {
    this.fingerprintCalls.push({ tenantId, domainPackId });
    return [...this.#index.values()].map(({ path, fingerprint }) => ({ path, fingerprint }));
  }

  async upsertFieldEmbeddings(
    _tenantId: string,
    _domainPackId: string,
    rows: readonly FieldEmbeddingRow[],
  ): Promise<{ upserted: number }> {
    this.upsertCalls.push([...rows]);
    for (const row of rows) this.#index.set(row.path, row);
    return { upserted: rows.length };
  }

  async searchSimilarFields(
    tenantId: string,
    domainPackId: string,
    embedding: number[],
    limit: number,
  ): Promise<readonly SimilarFieldMatch[]> {
    this.searchCalls.push({ tenantId, domainPackId, embedding, limit });
    if (this.options.matches) return this.options.matches;
    return [...this.#index.values()]
      .map((row) => ({
        path: row.path,
        label: row.label,
        aliases: row.aliases,
        similarity: cosineSimilarity(embedding, row.embedding),
      }))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, limit);
  }
}

/** Wraps the deterministic provider so tests can prove which model calls were made. */
class RecordingModelProvider implements ModelProvider {
  readonly schemaNames: string[] = [];
  readonly embedCalls: string[][] = [];
  readonly #inner: DeterministicModelProvider;
  readonly #embedder: ((text: string) => number[]) | undefined;

  constructor(responses: Readonly<Record<string, unknown>>, embedder?: (text: string) => number[]) {
    this.#inner = new DeterministicModelProvider(responses);
    this.#embedder = embedder;
  }

  capabilities(): ProviderCapabilities {
    return this.#inner.capabilities();
  }

  health(): Promise<ProviderResult<{ status: 'healthy' | 'degraded' }>> {
    return this.#inner.health();
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<ProviderResult<T>> {
    this.schemaNames.push(request.schemaName);
    return this.#inner.generateStructured(request);
  }

  async embed(texts: readonly string[]): Promise<ProviderResult<number[][]>> {
    this.embedCalls.push([...texts]);
    const result = await this.#inner.embed(texts);
    const embedder = this.#embedder;
    if (!result.ok || !embedder) return result;
    return { ...result, value: texts.map((text) => embedder(text)) };
  }
}

/**
 * Stands in for `embeddinggemma`: wording that means the same thing lands on the same axis, so the
 * end-to-end test exercises the recall ladder rather than a real embedding model's quality. Words
 * outside the concept lexicon carry a tenth of the weight, the way surrounding prose does.
 */
const CONCEPT_AXIS: Readonly<Record<string, number>> = {
  coverage: 0,
  cover: 0,
  liability: 0,
  limit: 0,
  amount: 0,
  sum: 0,
  excess: 1,
  deductible: 1,
  valid: 2,
  validity: 2,
  until: 2,
  expiry: 2,
  date: 2,
  insured: 3,
  legal: 3,
  entity: 3,
  name: 3,
  policyholder: 3,
};
const CONCEPT_DIMENSIONS = 8;
const OFF_CONCEPT_WEIGHT = 0.1;

function conceptEmbedding(text: string): number[] {
  const vector = Array.from({ length: CONCEPT_DIMENSIONS }, () => 0);
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const concept = CONCEPT_AXIS[token];
    if (concept === undefined) {
      const axis = 4 + (token.length % 4);
      vector[axis] = vector[axis]! + OFF_CONCEPT_WEIGHT;
      continue;
    }
    vector[concept] = vector[concept]! + 1;
  }
  const magnitude = Math.hypot(...vector) || 1;
  return vector.map((value) => value / magnitude);
}

function run(input: {
  store: StubFieldDictionaryStore;
  model: RecordingModelProvider;
  similarityFloor?: number;
}) {
  return generateFieldProposals({
    tenantId: 'tenant_demo',
    domainPackId: 'pharmacy-supplier',
    policyDocumentId: 'policy_v3',
    fallbackPack: pharmacySupplierPack,
    chunks: [chunk],
    model: input.model,
    embeddings: input.model,
    store: input.store,
    timeoutMs: 1_000,
    ...(input.similarityFloor === undefined ? {} : { similarityFloor: input.similarityFloor }),
  });
}

function modelFor(
  candidates: GeneratedCandidate[],
  dedup?: { matchedPath: string | null; reason: string },
  embedder?: (text: string) => number[],
): RecordingModelProvider {
  return new RecordingModelProvider(
    {
      policy_field_proposals: { fields: candidates },
      ...(dedup ? { policy_field_dedup: dedup } : {}),
    },
    embedder,
  );
}

const liabilityMatch: SimilarFieldMatch = {
  path: 'insurance.liabilityLimitEur',
  label: 'Liability limit',
  aliases: ['coverage', 'cover'],
  similarity: 0.91,
};

describe('policy field proposal stage', () => {
  it('resolves the persisted tenant pack before the compiled fallback', async () => {
    const persisted = parseDomainPack({
      ...pharmacySupplierPack,
      documentTypes: pharmacySupplierPack.documentTypes.map((type) =>
        type.id === 'insurance_certificate'
          ? {
              ...type,
              extractionFields: [
                ...type.extractionFields,
                {
                  path: 'insurance.excessEur',
                  label: 'Policy excess',
                  type: 'currency',
                  required: false,
                  aliases: ['deductible'],
                },
              ],
            }
          : type,
      ),
    });
    const store = new StubFieldDictionaryStore({ pack: persisted });
    const model = modelFor([candidate()]);

    const proposals = await run({ store, model });

    expect(store.packCalls).toEqual([
      { tenantId: 'tenant_demo', domainPackId: 'pharmacy-supplier' },
    ]);
    expect(proposals[0]!.status).toBe('invalid');
    expect(proposals[0]!.issues).toEqual([expect.objectContaining({ code: 'path_collision' })]);
    // The same candidate is admissible against the compiled fallback, which lacks that field.
    const fallbackProposals = await run({
      store: new StubFieldDictionaryStore(),
      model: modelFor([candidate()]),
    });
    expect(fallbackProposals[0]!.status).toBe('proposed');
  });

  it('blocks ungrounded, colliding, mistyped and unnamed candidates before any dedup work', async () => {
    const candidates = [
      candidate({
        citation: {
          chunkId: 'chunk_policy',
          page: 1,
          quote: 'The insurer shall apply a policy excess of no more than EUR 9,999 per claim.',
        },
      }),
      candidate({
        path: 'insurance.liabilityLimitEur',
        label: 'Liability limit',
        aliases: [],
        citation: { chunkId: 'chunk_policy', page: 1, quote: limitQuote },
      }),
      candidate({ fieldType: 'integer' }),
      candidate({
        path: 'insurance.renewalWindowDays',
        label: 'Renewal window',
        fieldType: 'number',
        aliases: ['grace period'],
      }),
    ];
    const store = new StubFieldDictionaryStore({ matches: [liabilityMatch] });
    const model = modelFor(candidates);

    const proposals = await run({ store, model });

    expect(proposals.map((proposal) => proposal.issues.map((issue) => issue.code))).toEqual([
      ['ungrounded_citation'],
      ['path_collision'],
      ['invalid_field_type'],
      ['label_not_in_quote'],
    ]);
    expect(proposals.every((proposal) => proposal.status === 'invalid')).toBe(true);
    expect(proposals.every((proposal) => proposal.embedding.length > 0)).toBe(true);
    expect(proposals[0]!.dedup).toMatchObject({ verdict: 'distinct', similarity: null });
    // A candidate that failed a gate never reaches the recall step or the judgment model.
    expect(store.searchCalls).toEqual([]);
    expect(model.schemaNames).toEqual(['policy_field_proposals']);
  });

  it('blocks malformed, reserved and misfiled paths', async () => {
    const candidates = [
      candidate({ path: 'insurance.excess-eur' }),
      candidate({ path: 'facts.insurance.excessEur' }),
      candidate({ documentTypeId: 'unknown_type' }),
    ];
    const store = new StubFieldDictionaryStore();
    const model = modelFor(candidates);

    const proposals = await run({ store, model });

    expect(proposals.map((proposal) => proposal.issues.map((issue) => issue.code))).toEqual([
      ['invalid_path'],
      ['reserved_path'],
      ['unknown_document_type'],
    ]);
    expect(store.searchCalls).toEqual([]);
  });

  it('indexes the pack, then embeds label, aliases and quote in a single call', async () => {
    const candidates = [candidate(), candidate({ path: 'insurance.excessNoteText' })];
    const store = new StubFieldDictionaryStore();
    const model = modelFor(candidates);

    await run({ store, model });

    // Two batches only: the pack vocabulary the index was missing, then the candidates.
    expect(model.embedCalls).toHaveLength(2);
    expect(model.embedCalls[0]).toHaveLength(packFieldPaths.length);
    // EmbeddingGemma needs its asymmetric task prefixes; bare text cannot separate these concepts.
    expect(model.embedCalls[0]).toContain(
      `title: none | text: ${['Liability limit', 'coverage', 'cover'].join('\n')}`,
    );
    expect(model.embedCalls[1]).toHaveLength(2);
    expect(model.embedCalls[1]![0]).toBe(
      `task: search result | query: ${['Policy excess', 'deductible', excessQuote].join('\n')}`,
    );
    expect(store.searchCalls).toHaveLength(2);
    expect(store.searchCalls[0]).toMatchObject({
      tenantId: 'tenant_demo',
      domainPackId: 'pharmacy-supplier',
      limit: FIELD_DEDUP_CANDIDATE_LIMIT,
    });
    expect(store.searchCalls[0]!.embedding.length).toBeGreaterThan(0);
  });

  it('rules a proposal distinct without calling the model when recall stays below the floor', async () => {
    const store = new StubFieldDictionaryStore({
      matches: [{ ...liabilityMatch, similarity: DEFAULT_FIELD_SIMILARITY_FLOOR - 0.01 }],
    });
    const model = modelFor([candidate()], {
      matchedPath: 'insurance.liabilityLimitEur',
      reason: 'The judgment model must never be consulted here.',
    });

    const proposals = await run({ store, model });

    expect(store.searchCalls).toHaveLength(1);
    expect(model.schemaNames).toEqual(['policy_field_proposals']);
    expect(proposals[0]!).toMatchObject({
      kind: 'new_field',
      path: 'insurance.excessEur',
      status: 'proposed',
      dedup: {
        verdict: 'distinct',
        matchedPath: null,
        similarity: DEFAULT_FIELD_SIMILARITY_FLOOR - 0.01,
      },
    });
    expect(proposals[0]!.dedup.reason).toContain('floor');
  });

  it('honours a configured similarity floor', async () => {
    const candidates = [
      candidate({
        label: 'Cover amount',
        path: 'insurance.coverAmountEur',
        aliases: ['cover'],
        citation: { chunkId: 'chunk_policy', page: 1, quote: coverQuote },
      }),
    ];
    const store = new StubFieldDictionaryStore({
      matches: [{ ...liabilityMatch, similarity: 0.5 }],
    });
    const model = modelFor(candidates, {
      matchedPath: 'insurance.liabilityLimitEur',
      reason: 'Both clauses name the product liability cover amount.',
    });

    const proposals = await run({ store, model, similarityFloor: 0.4 });

    expect(model.schemaNames).toEqual(['policy_field_proposals', 'policy_field_dedup']);
    expect(proposals[0]!.kind).toBe('alias');
  });

  it('rejects a similarity floor outside the unit interval', async () => {
    await expect(
      run({
        store: new StubFieldDictionaryStore(),
        model: modelFor([candidate()]),
        similarityFloor: 1.4,
      }),
    ).rejects.toThrow(/similarity floor/i);
  });

  it('rewrites a duplicate verdict into an alias carrying only the new wording', async () => {
    const candidates = [
      candidate({
        label: 'Cover amount',
        path: 'insurance.coverAmountEur',
        aliases: ['cover'],
        citation: { chunkId: 'chunk_policy', page: 1, quote: coverQuote },
      }),
    ];
    const store = new StubFieldDictionaryStore({ matches: [liabilityMatch] });
    const model = modelFor(candidates, {
      matchedPath: 'insurance.liabilityLimitEur',
      reason: 'Both clauses name the product liability cover amount.',
    });

    const proposals = await run({ store, model });

    expect(model.schemaNames).toEqual(['policy_field_proposals', 'policy_field_dedup']);
    expect(proposals[0]!).toMatchObject({
      kind: 'alias',
      documentTypeId: 'insurance_certificate',
      path: 'insurance.liabilityLimitEur',
      label: 'Liability limit',
      fieldType: 'currency',
      // "cover" is already an alias of the matched field, so only the new wording survives.
      aliases: ['Cover amount'],
      status: 'proposed',
      issues: [],
      dedup: {
        verdict: 'duplicate',
        matchedPath: 'insurance.liabilityLimitEur',
        similarity: 0.91,
        reason: 'Both clauses name the product liability cover amount.',
      },
    });
  });

  it('keeps a genuinely new concept as a new field when the model answers none', async () => {
    const store = new StubFieldDictionaryStore({ matches: [liabilityMatch] });
    const model = modelFor([candidate()], {
      matchedPath: null,
      reason: 'An excess is money the supplier bears, not the insured limit.',
    });

    const proposals = await run({ store, model });

    expect(model.schemaNames).toEqual(['policy_field_proposals', 'policy_field_dedup']);
    expect(proposals[0]!).toMatchObject({
      kind: 'new_field',
      documentTypeId: 'insurance_certificate',
      path: 'insurance.excessEur',
      label: 'Policy excess',
      fieldType: 'currency',
      aliases: ['deductible'],
      status: 'proposed',
      issues: [],
      dedup: { verdict: 'distinct', matchedPath: null, similarity: 0.91 },
    });
    expect(proposals[0]!.citation).toEqual({
      chunkId: 'chunk_policy',
      page: 1,
      quote: excessQuote,
    });
  });

  it('discards a matched path the recall step never offered', async () => {
    const store = new StubFieldDictionaryStore({ matches: [liabilityMatch] });
    const model = modelFor([candidate()], {
      matchedPath: 'insurance.inventedByTheModel',
      reason: 'The model named a field that was never recalled.',
    });

    const proposals = await run({ store, model });

    expect(proposals[0]!).toMatchObject({ kind: 'new_field', dedup: { verdict: 'distinct' } });
    expect(proposals[0]!.dedup.reason).toContain('insurance.inventedByTheModel');
  });

  it('refuses to alias a proposal onto a field of a different type', async () => {
    const candidates = [
      candidate({
        label: 'Cover end date',
        path: 'insurance.coverEndDate',
        fieldType: 'date',
        aliases: [],
        citation: { chunkId: 'chunk_policy', page: 1, quote: endDateQuote },
      }),
    ];
    const store = new StubFieldDictionaryStore({
      matches: [{ ...liabilityMatch, similarity: 0.95 }],
    });
    const model = modelFor(candidates, {
      matchedPath: 'insurance.liabilityLimitEur',
      reason: 'The model claims these are the same field.',
    });

    const proposals = await run({ store, model });

    expect(proposals[0]!).toMatchObject({
      kind: 'new_field',
      path: 'insurance.coverEndDate',
      fieldType: 'date',
      dedup: { verdict: 'distinct', matchedPath: null, similarity: 0.95 },
    });
    expect(proposals[0]!.dedup.reason).toContain('currency');
  });

  it('invalidates an alias that would add no wording at all', async () => {
    const candidates = [
      candidate({
        label: 'Coverage',
        path: 'insurance.coverageEur',
        aliases: ['cover'],
        citation: { chunkId: 'chunk_policy', page: 1, quote: coverageQuote },
      }),
    ];
    const store = new StubFieldDictionaryStore({ matches: [liabilityMatch] });
    const model = modelFor(candidates, {
      matchedPath: 'insurance.liabilityLimitEur',
      reason: 'The wording already exists on the matched field.',
    });

    const proposals = await run({ store, model });

    expect(proposals[0]!).toMatchObject({
      kind: 'alias',
      aliases: [],
      status: 'invalid',
      issues: [expect.objectContaining({ code: 'alias_adds_nothing' })],
    });
  });

  it('accepts a facts-prefixed recall path and repairs a misnamed chunk id', async () => {
    const candidates = [
      candidate({
        label: 'Cover amount',
        path: 'insurance.coverAmountEur',
        aliases: [],
        citation: { chunkId: 'model-returned-wrong-id', page: 1, quote: coverQuote },
      }),
    ];
    const store = new StubFieldDictionaryStore({
      matches: [{ ...liabilityMatch, path: 'facts.insurance.liabilityLimitEur' }],
    });
    const model = modelFor(candidates, {
      matchedPath: 'facts.insurance.liabilityLimitEur',
      reason: 'Both clauses name the same cover amount.',
    });

    const proposals = await run({ store, model });

    expect(proposals[0]!.citation.chunkId).toBe('chunk_policy');
    expect(proposals[0]!).toMatchObject({
      kind: 'alias',
      path: 'insurance.liabilityLimitEur',
      status: 'proposed',
      dedup: { matchedPath: 'insurance.liabilityLimitEur' },
    });
  });

  it('returns nothing when the policy has no clauses', async () => {
    const store = new StubFieldDictionaryStore();
    const model = modelFor([candidate()]);

    const proposals = await generateFieldProposals({
      tenantId: 'tenant_demo',
      domainPackId: 'pharmacy-supplier',
      policyDocumentId: 'policy_v3',
      fallbackPack: pharmacySupplierPack,
      chunks: [],
      model,
      embeddings: model,
      store,
      timeoutMs: 1_000,
    });

    expect(proposals).toEqual([]);
    expect(model.schemaNames).toEqual([]);
    expect(store.packCalls).toEqual([]);
  });
});

describe('field embedding index sync', () => {
  const sync = (input: {
    store: StubFieldDictionaryStore;
    model: RecordingModelProvider;
    pack?: DomainPack;
  }) =>
    syncFieldEmbeddingIndex({
      tenantId: 'tenant_demo',
      domainPackId: 'pharmacy-supplier',
      pack: input.pack ?? pharmacySupplierPack,
      embeddings: input.model,
      store: input.store,
    });

  it('recalls a compiled-pack field that was never proposed', async () => {
    const store = new StubFieldDictionaryStore();
    const model = modelFor([], undefined, conceptEmbedding);

    // `insurance.liabilityLimitEur` ships inside the compiled pack, so no proposal row can ever
    // exist for it. Before the sync the recall corpus is empty and every wording of it would be
    // ruled distinct; afterwards it is recallable like any other field.
    expect(
      await store.searchSimilarFields(
        'tenant_demo',
        'pharmacy-supplier',
        conceptEmbedding('coverage amount'),
        5,
      ),
    ).toEqual([]);

    expect(await sync({ store, model })).toEqual({
      indexed: packFieldPaths.length,
      skipped: 0,
    });
    expect(store.indexedPaths).toEqual([...packFieldPaths].sort());

    const [match] = await store.searchSimilarFields(
      'tenant_demo',
      'pharmacy-supplier',
      conceptEmbedding('coverage amount'),
      5,
    );
    expect(match).toMatchObject({
      path: 'insurance.liabilityLimitEur',
      label: 'Liability limit',
      aliases: ['coverage', 'cover'],
    });
    expect(match!.similarity).toBeGreaterThan(DEFAULT_FIELD_SIMILARITY_FLOOR);
  });

  it('makes exactly one batched embedding call for the fields it must index', async () => {
    const store = new StubFieldDictionaryStore();
    const model = modelFor([], undefined, conceptEmbedding);

    await sync({ store, model });

    expect(model.embedCalls).toHaveLength(1);
    expect(model.embedCalls[0]).toHaveLength(packFieldPaths.length);
    expect(store.fingerprintCalls).toEqual([
      { tenantId: 'tenant_demo', domainPackId: 'pharmacy-supplier' },
    ]);
    expect(store.upsertCalls).toHaveLength(1);
    expect(store.upsertCalls[0]!.map((row) => row.path).sort()).toEqual([...packFieldPaths].sort());
  });

  it('re-embeds a field whose aliases changed and skips one that did not', async () => {
    const store = new StubFieldDictionaryStore();
    const model = modelFor([], undefined, conceptEmbedding);
    await sync({ store, model });

    // An unchanged pack costs one fingerprint read and no embedding at all.
    expect(await sync({ store, model })).toEqual({ indexed: 0, skipped: packFieldPaths.length });
    expect(model.embedCalls).toHaveLength(1);

    const widened = parseDomainPack({
      ...pharmacySupplierPack,
      documentTypes: pharmacySupplierPack.documentTypes.map((documentType) => ({
        ...documentType,
        extractionFields: documentType.extractionFields.map((field) =>
          field.path === 'insurance.liabilityLimitEur'
            ? { ...field, aliases: [...field.aliases, 'sum insured'] }
            : field,
        ),
      })),
    });

    expect(await sync({ store, model, pack: widened })).toEqual({
      indexed: 1,
      skipped: packFieldPaths.length - 1,
    });
    expect(model.embedCalls).toHaveLength(2);
    expect(model.embedCalls[1]).toEqual([
      `title: none | text: ${['Liability limit', 'coverage', 'cover', 'sum insured'].join('\n')}`,
    ]);
    expect(store.upsertCalls.at(-1)!.map((row) => row.path)).toEqual([
      'insurance.liabilityLimitEur',
    ]);
  });

  it('turns "coverage amount" into an alias on the compiled liability limit field', async () => {
    // The end-to-end proof. Nothing seeds the index, no proposal for this field has ever existed,
    // and the pharmacy pack's own `insurance.liabilityLimitEur` is what must absorb the wording.
    const store = new StubFieldDictionaryStore();
    const model = modelFor(
      [
        candidate({
          path: 'insurance.coverageAmountEur',
          label: 'Coverage amount',
          fieldType: 'currency',
          aliases: [],
          citation: { chunkId: 'chunk_policy', page: 1, quote: coverageAmountQuote },
        }),
      ],
      {
        matchedPath: 'insurance.liabilityLimitEur',
        reason: 'Both clauses name the product liability cover the supplier must hold.',
      },
      conceptEmbedding,
    );

    const proposals = await run({ store, model });

    expect(model.schemaNames).toEqual(['policy_field_proposals', 'policy_field_dedup']);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!).toMatchObject({
      kind: 'alias',
      documentTypeId: 'insurance_certificate',
      path: 'insurance.liabilityLimitEur',
      label: 'Liability limit',
      fieldType: 'currency',
      aliases: ['Coverage amount'],
      status: 'proposed',
      issues: [],
      dedup: { verdict: 'duplicate', matchedPath: 'insurance.liabilityLimitEur' },
    });
    expect(proposals[0]!.dedup.similarity).toBeGreaterThan(DEFAULT_FIELD_SIMILARITY_FLOOR);
  });
});
