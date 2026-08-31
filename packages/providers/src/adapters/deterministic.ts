import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  fail,
  ok,
  type DocumentTextProvider,
  type JobQueueProvider,
  type ModelProvider,
  type ObjectStorageProvider,
  type OcrProvider,
  type PolicyChunkRecord,
  type ProviderCapabilities,
  type ProviderResult,
  type SearchHit,
  type StructuredGenerationRequest,
  type TextPage,
  type VectorSearchProvider,
  type VirusScannerProvider,
} from '../ports.js';

const health = async () => ok({ status: 'healthy' as const });

function embedText(text: string, dimensions = 16): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const digest = createHash('sha256').update(token).digest();
    const index = digest[0]! % dimensions;
    vector[index] = vector[index]! + (digest[1]! % 2 ? 1 : -1);
  }
  const magnitude = Math.hypot(...vector) || 1;
  return vector.map((value) => value / magnitude);
}

export class DeterministicModelProvider implements ModelProvider {
  constructor(
    private readonly responses: Readonly<Record<string, unknown>> = {},
    private readonly id = 'deterministic-model',
    private readonly dimensions = 16,
  ) {}
  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      features: ['structured-generation', 'embeddings'],
      maxInputBytes: 1_000_000,
    };
  }
  health = health;
  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<ProviderResult<T>> {
    const response = this.responses[request.schemaName];
    const parsed = request.schema.safeParse(response);
    return parsed.success
      ? ok(parsed.data, { providerId: this.id, model: 'fixture-v1' })
      : fail('invalid_response', `No valid deterministic response for ${request.schemaName}`);
  }
  async embed(texts: readonly string[]): Promise<ProviderResult<number[][]>> {
    return ok(
      texts.map((text) => embedText(text, this.dimensions)),
      { providerId: this.id, model: `hash-${this.dimensions}` },
    );
  }
}

export class DeterministicTextProvider implements DocumentTextProvider {
  constructor(
    private readonly pages: readonly TextPage[] = [],
    private readonly id = 'deterministic-text',
  ) {}
  capabilities(): ProviderCapabilities {
    return { id: this.id, features: ['native-text'], maxInputBytes: 25_000_000 };
  }
  health = health;
  async extract(_input: Uint8Array, mediaType: string): Promise<ProviderResult<TextPage[]>> {
    if (mediaType !== 'application/pdf' && !mediaType.startsWith('text/'))
      return fail('unsupported', `Unsupported media type: ${mediaType}`);
    return ok(
      this.pages.map((page) => ({ ...page })),
      { providerId: this.id },
    );
  }
}

export class DeterministicOcrProvider implements OcrProvider {
  constructor(
    private readonly pageText: Readonly<Record<number, TextPage>> = {},
    private readonly id = 'deterministic-ocr',
  ) {}
  capabilities(): ProviderCapabilities {
    return { id: this.id, features: ['ocr', 'orientation'], languages: ['de', 'en', 'fr'] };
  }
  health = health;
  async recognize(
    _input: Uint8Array,
    options: { page: number },
  ): Promise<ProviderResult<TextPage>> {
    const page = this.pageText[options.page];
    return page
      ? ok({ ...page }, { providerId: this.id })
      : fail('invalid_response', `No OCR fixture for page ${options.page}`);
  }
}

export class MemoryObjectStorageProvider implements ObjectStorageProvider {
  readonly #items = new Map<string, Uint8Array>();
  capabilities(): ProviderCapabilities {
    return { id: 'memory-storage', features: ['immutable-object-storage'] };
  }
  health = health;
  async put(key: string, body: Uint8Array): Promise<ProviderResult<{ etag: string }>> {
    if (this.#items.has(key)) return fail('conflict', `Object already exists: ${key}`);
    this.#items.set(key, body.slice());
    return ok(
      { etag: createHash('sha256').update(body).digest('hex') },
      { providerId: 'memory-storage' },
    );
  }
  async get(key: string): Promise<ProviderResult<Uint8Array>> {
    const item = this.#items.get(key);
    return item ? ok(item.slice()) : fail('not_found', `Object not found: ${key}`);
  }
}

export class MemoryVectorSearchProvider implements VectorSearchProvider {
  readonly #chunks = new Map<string, PolicyChunkRecord>();
  capabilities(): ProviderCapabilities {
    return {
      id: 'memory-vector',
      features: ['vector-search', 'lexical-search', 'scope-filtering'],
    };
  }
  health = health;
  async index(chunks: readonly PolicyChunkRecord[]): Promise<ProviderResult<{ indexed: number }>> {
    for (const chunk of chunks)
      this.#chunks.set(chunk.id, {
        ...chunk,
        embedding: [...chunk.embedding],
        tags: [...chunk.tags],
      });
    return ok({ indexed: chunks.length });
  }
  async search(query: {
    text: string;
    embedding: readonly number[];
    limit: number;
    scope: {
      tenantId: string;
      domainId: string;
      packVersion: string;
      at: string;
      collectionIds?: readonly string[];
    };
  }): Promise<ProviderResult<SearchHit[]>> {
    const at = Date.parse(query.scope.at);
    if (!Number.isFinite(at)) return fail('invalid_response', 'Search scope date is invalid');
    const terms = new Set(query.text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const hits = [...this.#chunks.values()]
      .filter(
        (chunk) =>
          chunk.tenantId === query.scope.tenantId &&
          chunk.domainId === query.scope.domainId &&
          chunk.packVersion === query.scope.packVersion &&
          (!query.scope.collectionIds || query.scope.collectionIds.includes(chunk.collectionId)) &&
          !chunk.revokedAt &&
          Date.parse(chunk.validFrom) <= at &&
          (!chunk.validTo || Date.parse(chunk.validTo) >= at),
      )
      .map((chunk) => {
        const dot = chunk.embedding.reduce(
          (sum, value, index) => sum + value * (query.embedding[index] ?? 0),
          0,
        );
        const words = chunk.text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        const lexicalScore = words.length
          ? words.filter((word) => terms.has(word)).length / words.length
          : 0;
        return { chunk, vectorScore: Math.max(0, dot), lexicalScore };
      })
      .sort((a, b) => b.vectorScore + b.lexicalScore - (a.vectorScore + a.lexicalScore))
      .slice(0, query.limit);
    return ok(hits);
  }
}

export class MemoryJobQueueProvider implements JobQueueProvider {
  readonly jobs = new Map<
    string,
    { id: string; type: string; payload: Readonly<Record<string, unknown>>; cancelled: boolean }
  >();
  capabilities(): ProviderCapabilities {
    return { id: 'memory-queue', features: ['enqueue', 'cancel', 'retry', 'idempotency'] };
  }
  health = health;
  async enqueue(
    type: string,
    payload: Readonly<Record<string, unknown>>,
    options: { idempotencyKey: string; maxAttempts: number },
  ): Promise<ProviderResult<{ jobId: string; duplicate: boolean }>> {
    const previous = this.jobs.get(options.idempotencyKey);
    if (previous) return ok({ jobId: previous.id, duplicate: true });
    const id = `job_${createHash('sha256').update(options.idempotencyKey).digest('hex').slice(0, 16)}`;
    this.jobs.set(options.idempotencyKey, { id, type, payload, cancelled: false });
    return ok({ jobId: id, duplicate: false });
  }
  async cancel(jobId: string): Promise<ProviderResult<void>> {
    const found = [...this.jobs.values()].find((job) => job.id === jobId);
    if (!found) return fail('not_found', `Job not found: ${jobId}`);
    found.cancelled = true;
    return ok(undefined);
  }
  async retry(jobId: string): Promise<ProviderResult<void>> {
    const found = [...this.jobs.values()].find((job) => job.id === jobId);
    if (!found) return fail('not_found', `Job not found: ${jobId}`);
    found.cancelled = false;
    return ok(undefined);
  }
}

export class DeterministicVirusScanner implements VirusScannerProvider {
  constructor(private readonly result: 'clean' | 'infected' | 'inconclusive' = 'clean') {}
  capabilities(): ProviderCapabilities {
    return { id: 'deterministic-scanner', features: ['malware-scan'] };
  }
  health = health;
  async scan(): Promise<
    ProviderResult<{ status: 'clean' | 'infected' | 'inconclusive'; signature?: string }>
  > {
    return ok(
      this.result === 'infected'
        ? { status: this.result, signature: 'EICAR-Test-Signature' }
        : { status: this.result },
    );
  }
}

export { embedText };
