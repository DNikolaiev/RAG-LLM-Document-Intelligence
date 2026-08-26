import { describe, expect, it } from 'vitest';
import {
  DeterministicModelProvider,
  MemoryVectorSearchProvider,
  fail,
  type ModelProvider,
} from '@caselens/providers';
import { chunkPolicyDocument, PolicyRetriever } from '../src/index.js';

const policy = {
  tenantId: 'tenant-a',
  domainId: 'pharmacy-supplier',
  packVersion: '1.0.0',
  documentId: 'insurance-policy',
  documentVersion: '3',
  collectionId: 'insurance',
  text: '# Insurance\n\nSuppliers shall maintain product liability coverage of at least EUR 2,000,000 per occurrence. Coverage must remain valid throughout qualification.',
  validFrom: '2026-01-01T00:00:00Z',
  validTo: null,
  revokedAt: null,
  tags: ['insurance', 'coverage'],
};

describe('policy chunking', () => {
  it('is deterministic, overlap-bounded, and rejects invalid options', () => {
    const first = chunkPolicyDocument(policy, { targetCharacters: 100, overlapCharacters: 20 });
    const second = chunkPolicyDocument(policy, { targetCharacters: 100, overlapCharacters: 20 });
    expect(first.map((chunk) => chunk.id)).toEqual(second.map((chunk) => chunk.id));
    expect(first.length).toBeGreaterThan(1);
    expect(() =>
      chunkPolicyDocument(policy, { targetCharacters: 99, overlapCharacters: 10 }),
    ).toThrow();
    expect(() =>
      chunkPolicyDocument(policy, { targetCharacters: 100, overlapCharacters: 100 }),
    ).toThrow();
  });
});

describe('hybrid retrieval', () => {
  it('indexes and returns cited, versioned in-scope policy', async () => {
    const retriever = new PolicyRetriever(
      new DeterministicModelProvider(),
      new MemoryVectorSearchProvider(),
    );
    expect(
      (await retriever.index(policy, { targetCharacters: 120, overlapCharacters: 20 })).indexed,
    ).toBeGreaterThan(0);
    const result = await retriever.retrieve(
      'minimum liability coverage EUR',
      {
        tenantId: 'tenant-a',
        domainId: 'pharmacy-supplier',
        packVersion: '1.0.0',
        at: '2026-08-26T00:00:00Z',
      },
      { limit: 2, threshold: 0.01 },
    );
    expect(result).toMatchObject({ status: 'found' });
    if (result.status === 'found')
      expect(result.citations[0]).toMatchObject({
        documentId: 'insurance-policy',
        documentVersion: '3',
        collectionId: 'insurance',
      });
  });

  it.each([
    ['', 'empty_query'],
    ['GDP', 'no_in_scope_policy'],
  ] as const)('abstains for %j', async (query, reason) => {
    const retriever = new PolicyRetriever(
      new DeterministicModelProvider(),
      new MemoryVectorSearchProvider(),
    );
    if (query) await retriever.index(policy, { targetCharacters: 120, overlapCharacters: 20 });
    const result = await retriever.retrieve(
      query,
      {
        tenantId: query ? 'wrong-tenant' : 'tenant-a',
        domainId: 'pharmacy-supplier',
        packVersion: '1.0.0',
        at: '2026-08-26T00:00:00Z',
      },
      { limit: 2, threshold: 0.01 },
    );
    expect(result).toEqual({ status: 'abstained', citations: [], reason });
  });

  it('abstains on embedding outage and below threshold', async () => {
    const down: ModelProvider = {
      capabilities: () => ({ id: 'down', features: ['embeddings'] }),
      health: async () => fail('unavailable', 'down'),
      embed: async () => fail('unavailable', 'down'),
      generateStructured: async () => fail('unavailable', 'down'),
    };
    const search = new MemoryVectorSearchProvider();
    expect(
      await new PolicyRetriever(down, search).retrieve(
        'x',
        { tenantId: 'a', domainId: 'd', packVersion: '1', at: '2026-01-01T00:00:00Z' },
        { limit: 1, threshold: 0.5 },
      ),
    ).toMatchObject({ reason: 'embedding_unavailable' });
    const retriever = new PolicyRetriever(new DeterministicModelProvider(), search);
    await retriever.index(policy, { targetCharacters: 120, overlapCharacters: 20 });
    expect(
      await retriever.retrieve(
        'unrelated zyxwv',
        {
          tenantId: 'tenant-a',
          domainId: 'pharmacy-supplier',
          packVersion: '1.0.0',
          at: '2026-08-26T00:00:00Z',
        },
        { limit: 1, threshold: 2 },
      ),
    ).toMatchObject({ reason: 'below_threshold' });
  });
});
