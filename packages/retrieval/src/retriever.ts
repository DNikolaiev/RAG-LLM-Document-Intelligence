import type {
  ModelProvider,
  PolicyChunkRecord,
  SearchScope,
  VectorSearchProvider,
} from '@caselens/providers';
import { chunkPolicyDocument, type ChunkingOptions, type PolicyDocumentInput } from './chunking.js';

export interface RetrievalCitation {
  chunkId: string;
  documentId: string;
  documentVersion: string;
  collectionId: string;
  quote: string;
  score: number;
  tags: string[];
}

export type RetrievalResult =
  | { status: 'found'; citations: RetrievalCitation[] }
  | {
      status: 'abstained';
      citations: [];
      reason:
        | 'empty_query'
        | 'embedding_unavailable'
        | 'search_unavailable'
        | 'no_in_scope_policy'
        | 'below_threshold';
    };

export class PolicyRetriever {
  constructor(
    private readonly embeddings: ModelProvider,
    private readonly search: VectorSearchProvider,
  ) {}

  async index(
    document: PolicyDocumentInput,
    options: ChunkingOptions,
  ): Promise<{ indexed: number; chunkIds: string[] }> {
    const chunks = chunkPolicyDocument(document, options);
    if (!chunks.length) return { indexed: 0, chunkIds: [] };
    const vectors = await this.embeddings.embed(chunks.map((chunk) => chunk.text));
    if (!vectors.ok) throw new Error(`Embedding failed: ${vectors.error.code}`);
    if (vectors.value.length !== chunks.length)
      throw new Error('Embedding provider returned the wrong vector count');
    const records: PolicyChunkRecord[] = chunks.map((chunk, index) => ({
      ...chunk,
      embedding: vectors.value[index]!,
    }));
    const result = await this.search.index(records);
    if (!result.ok) throw new Error(`Indexing failed: ${result.error.code}`);
    return { indexed: result.value.indexed, chunkIds: records.map((record) => record.id) };
  }

  async retrieve(
    query: string,
    scope: SearchScope,
    options: { limit: number; threshold: number; vectorWeight?: number },
  ): Promise<RetrievalResult> {
    if (!query.trim()) return { status: 'abstained', citations: [], reason: 'empty_query' };
    const embedded = await this.embeddings.embed([query]);
    if (!embedded.ok || !embedded.value[0])
      return { status: 'abstained', citations: [], reason: 'embedding_unavailable' };
    const result = await this.search.search({
      text: query,
      embedding: embedded.value[0],
      limit: Math.max(options.limit * 3, options.limit),
      scope,
    });
    if (!result.ok) return { status: 'abstained', citations: [], reason: 'search_unavailable' };
    const at = Date.parse(scope.at);
    const vectorWeight = options.vectorWeight ?? 0.7;
    const hits = result.value
      .filter(
        ({ chunk }) =>
          chunk.tenantId === scope.tenantId &&
          chunk.domainId === scope.domainId &&
          chunk.packVersion === scope.packVersion &&
          !chunk.revokedAt &&
          Date.parse(chunk.validFrom) <= at &&
          (!chunk.validTo || Date.parse(chunk.validTo) >= at),
      )
      .map((hit) => ({
        hit,
        score: hit.vectorScore * vectorWeight + hit.lexicalScore * (1 - vectorWeight),
      }))
      .sort((a, b) => b.score - a.score || a.hit.chunk.id.localeCompare(b.hit.chunk.id));
    if (!hits.length) return { status: 'abstained', citations: [], reason: 'no_in_scope_policy' };
    const passing = hits.filter(({ score }) => score >= options.threshold).slice(0, options.limit);
    if (!passing.length) return { status: 'abstained', citations: [], reason: 'below_threshold' };
    return {
      status: 'found',
      citations: passing.map(({ hit, score }) => ({
        chunkId: hit.chunk.id,
        documentId: hit.chunk.documentId,
        documentVersion: hit.chunk.documentVersion,
        collectionId: hit.chunk.collectionId,
        quote: hit.chunk.text.slice(0, 500),
        score,
        tags: [...hit.chunk.tags],
      })),
    };
  }
}
