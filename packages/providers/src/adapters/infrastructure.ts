import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import postgres from 'postgres';
import {
  fail,
  ok,
  type JobQueueProvider,
  type ObjectStorageProvider,
  type PolicyChunkRecord,
  type ProviderCapabilities,
  type ProviderResult,
  type SearchHit,
  type SearchScope,
  type VectorSearchProvider,
} from '../ports.js';

export interface S3CompatibleConfig {
  id: string;
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}
export class S3CompatibleStorageProvider implements ObjectStorageProvider {
  readonly #client: S3Client;
  constructor(private readonly config: S3CompatibleConfig) {
    if (!config.bucket || !config.accessKeyId || !config.secretAccessKey)
      throw new Error('S3-compatible provider is misconfigured');
    this.#client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }
  capabilities(): ProviderCapabilities {
    return { id: this.config.id, features: ['immutable-object-storage'] };
  }
  async health(): Promise<ProviderResult<{ status: 'healthy' | 'degraded' }>> {
    return ok({ status: 'healthy' });
  }
  async put(
    key: string,
    body: Uint8Array,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<ProviderResult<{ etag: string }>> {
    try {
      const result = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          Metadata: metadata,
          IfNoneMatch: '*',
        }),
      );
      return ok({ etag: result.ETag ?? '' }, { providerId: this.config.id });
    } catch (error) {
      return fail('unavailable', 'S3 put failed', true, { cause: error });
    }
  }
  async get(key: string): Promise<ProviderResult<Uint8Array>> {
    try {
      const result = await this.#client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!result.Body) return fail('not_found', `Object not found: ${key}`);
      return ok(await result.Body.transformToByteArray(), { providerId: this.config.id });
    } catch (error) {
      return fail('unavailable', 'S3 get failed', true, { cause: error });
    }
  }
}

export interface BullMqConfig {
  id: string;
  queueName: string;
  connection: { host: string; port: number; password?: string };
}
export class BullMqQueueProvider implements JobQueueProvider {
  readonly #queue: Queue;
  constructor(private readonly config: BullMqConfig) {
    this.#queue = new Queue(config.queueName, { connection: config.connection });
  }
  capabilities(): ProviderCapabilities {
    return { id: this.config.id, features: ['enqueue', 'cancel', 'idempotency', 'retries'] };
  }
  async health(): Promise<ProviderResult<{ status: 'healthy' | 'degraded' }>> {
    try {
      await this.#queue.waitUntilReady();
      return ok({ status: 'healthy' });
    } catch (error) {
      return fail('unavailable', 'BullMQ is unavailable', true, { cause: error });
    }
  }
  async enqueue(
    type: string,
    payload: Readonly<Record<string, unknown>>,
    options: { idempotencyKey: string; maxAttempts: number },
  ): Promise<ProviderResult<{ jobId: string; duplicate: boolean }>> {
    try {
      const prior = await this.#queue.getJob(options.idempotencyKey);
      if (prior) return ok({ jobId: prior.id ?? options.idempotencyKey, duplicate: true });
      const job = await this.#queue.add(type, payload, {
        jobId: options.idempotencyKey,
        attempts: options.maxAttempts,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1000,
      });
      return ok({ jobId: job.id ?? options.idempotencyKey, duplicate: false });
    } catch (error) {
      return fail('unavailable', 'BullMQ enqueue failed', true, { cause: error });
    }
  }
  async cancel(jobId: string): Promise<ProviderResult<void>> {
    try {
      const job = await this.#queue.getJob(jobId);
      if (!job) return fail('not_found', `Job not found: ${jobId}`);
      await job.remove();
      return ok(undefined);
    } catch (error) {
      return fail('unavailable', 'BullMQ cancellation failed', true, { cause: error });
    }
  }
}

export interface PgVectorConfig {
  id: string;
  connectionString: string;
  dimensions?: number;
}
export class PgVectorSearchProvider implements VectorSearchProvider {
  readonly #sql: ReturnType<typeof postgres>;
  constructor(private readonly config: PgVectorConfig) {
    if (!config.connectionString) throw new Error('PostgreSQL vector provider is misconfigured');
    this.#sql = postgres(config.connectionString, { max: 5, prepare: false });
  }
  capabilities(): ProviderCapabilities {
    return { id: this.config.id, features: ['vector-search', 'lexical-search', 'scope-filtering'] };
  }
  async health(): Promise<ProviderResult<{ status: 'healthy' | 'degraded' }>> {
    try {
      await this.#sql`select 1`;
      return ok({ status: 'healthy' });
    } catch (error) {
      return fail('unavailable', 'PostgreSQL is unavailable', true, { cause: error });
    }
  }
  async index(chunks: readonly PolicyChunkRecord[]): Promise<ProviderResult<{ indexed: number }>> {
    const expectedDimensions = this.config.dimensions ?? 1536;
    const mismatched = chunks.find((chunk) => chunk.embedding.length !== expectedDimensions);
    if (mismatched) {
      return fail(
        'invalid_response',
        `Embedding dimension mismatch for ${mismatched.id}: expected ${expectedDimensions}, received ${mismatched.embedding.length}`,
      );
    }
    try {
      for (const chunk of chunks)
        await this
          .#sql`insert into policy_search_chunks (id, tenant_id, domain_id, pack_version, document_id, document_version, collection_id, content, embedding, valid_from, valid_to, revoked_at, tags) values (${chunk.id}, ${chunk.tenantId}, ${chunk.domainId}, ${chunk.packVersion}, ${chunk.documentId}, ${chunk.documentVersion}, ${chunk.collectionId}, ${chunk.text}, ${JSON.stringify(chunk.embedding)}::vector, ${chunk.validFrom}, ${chunk.validTo}, ${chunk.revokedAt}, ${chunk.tags}) on conflict (id) do update set content = excluded.content, embedding = excluded.embedding, valid_from = excluded.valid_from, valid_to = excluded.valid_to, revoked_at = excluded.revoked_at, tags = excluded.tags`;
      return ok({ indexed: chunks.length });
    } catch (error) {
      return fail('unavailable', 'Policy indexing failed', true, { cause: error });
    }
  }
  async search(query: {
    text: string;
    embedding: readonly number[];
    limit: number;
    scope: SearchScope;
  }): Promise<ProviderResult<SearchHit[]>> {
    const expectedDimensions = this.config.dimensions ?? 1536;
    if (query.embedding.length !== expectedDimensions) {
      return fail(
        'invalid_response',
        `Query embedding dimension mismatch: expected ${expectedDimensions}, received ${query.embedding.length}`,
      );
    }
    try {
      const rows = await this.#sql<
        Array<PolicyChunkRecord & { vector_score: number; lexical_score: number }>
      >`
        select id, tenant_id as "tenantId", domain_id as "domainId", pack_version as "packVersion", document_id as "documentId", document_version as "documentVersion", collection_id as "collectionId", content as text, embedding::text, valid_from as "validFrom", valid_to as "validTo", revoked_at as "revokedAt", tags,
          greatest(0, 1 - (embedding <=> ${JSON.stringify(query.embedding)}::vector)) as vector_score,
          ts_rank_cd(search_vector, websearch_to_tsquery('simple', ${query.text})) as lexical_score
        from policy_search_chunks where tenant_id = ${query.scope.tenantId} and domain_id = ${query.scope.domainId} and pack_version = ${query.scope.packVersion}
          and revoked_at is null and valid_from <= ${query.scope.at}::timestamptz and (valid_to is null or valid_to >= ${query.scope.at}::timestamptz)
          and (${query.scope.collectionIds ?? null}::text[] is null or collection_id = any(${query.scope.collectionIds ?? null}::text[]))
        order by (1 - (embedding <=> ${JSON.stringify(query.embedding)}::vector)) * 0.7 + ts_rank_cd(search_vector, websearch_to_tsquery('simple', ${query.text})) * 0.3 desc limit ${query.limit}`;
      return ok(
        rows.map((row) => ({
          chunk: {
            ...row,
            embedding:
              typeof row.embedding === 'string'
                ? (JSON.parse(row.embedding) as number[])
                : row.embedding,
          },
          vectorScore: Number(row.vector_score),
          lexicalScore: Number(row.lexical_score),
        })),
      );
    } catch (error) {
      return fail('unavailable', 'Policy search failed', true, { cause: error });
    }
  }
}
