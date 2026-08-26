import type {
  CaseDetail,
  CaseId,
  CaseSummary,
  DocumentId,
  Job,
  TenantId,
} from '@caselens/contracts';
import type { z } from 'zod';

export type ProviderErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'invalid_response'
  | 'unavailable'
  | 'unsupported'
  | 'misconfigured'
  | 'not_found'
  | 'conflict';
export type ProviderResult<T> =
  { ok: true; value: T; meta?: ProviderMeta } | { ok: false; error: ProviderError };
export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  cause?: unknown;
}
export interface ProviderMeta {
  providerId: string;
  model?: string;
  durationMs?: number;
  tokens?: { input: number; output: number };
  estimatedCostUsd?: number;
}
export interface ProviderCapabilities {
  id: string;
  features: readonly string[];
  maxInputBytes?: number;
  languages?: readonly string[];
}
export interface Provider {
  capabilities(): ProviderCapabilities;
  health(): Promise<ProviderResult<{ status: 'healthy' | 'degraded' }>>;
}

export interface StructuredGenerationRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  timeoutMs: number;
  redacted?: boolean;
}
export interface ModelProvider extends Provider {
  generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<ProviderResult<T>>;
  embed(texts: readonly string[]): Promise<ProviderResult<number[][]>>;
}

export interface TextPage {
  page: number;
  text: string;
  rotation: 0 | 90 | 180 | 270;
  language?: string | undefined;
  confidence: number;
  blocks?: readonly TextBlock[] | undefined;
}
export interface TextBlock {
  text: string;
  confidence: number;
  boundingBox?: { x: number; y: number; width: number; height: number } | undefined;
}
export interface DocumentTextProvider extends Provider {
  extract(input: Uint8Array, mediaType: string): Promise<ProviderResult<TextPage[]>>;
}
export interface OcrProvider extends Provider {
  recognize(
    input: Uint8Array,
    options: { page: number; rotation?: number; languageHints?: readonly string[] },
  ): Promise<ProviderResult<TextPage>>;
}
export interface ObjectStorageProvider extends Provider {
  put(
    key: string,
    body: Uint8Array,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<ProviderResult<{ etag: string }>>;
  get(key: string): Promise<ProviderResult<Uint8Array>>;
}

export interface PolicyChunkRecord {
  id: string;
  tenantId: string;
  domainId: string;
  packVersion: string;
  documentId: string;
  documentVersion: string;
  collectionId: string;
  text: string;
  embedding: number[];
  validFrom: string;
  validTo: string | null;
  revokedAt: string | null;
  tags: string[];
}
export interface SearchScope {
  tenantId: string;
  domainId: string;
  packVersion: string;
  at: string;
  collectionIds?: readonly string[];
}
export interface SearchHit {
  chunk: PolicyChunkRecord;
  vectorScore: number;
  lexicalScore: number;
}
export interface VectorSearchProvider extends Provider {
  index(chunks: readonly PolicyChunkRecord[]): Promise<ProviderResult<{ indexed: number }>>;
  search(query: {
    text: string;
    embedding: readonly number[];
    limit: number;
    scope: SearchScope;
  }): Promise<ProviderResult<SearchHit[]>>;
}

export interface JobQueueProvider extends Provider {
  enqueue(
    type: string,
    payload: Readonly<Record<string, unknown>>,
    options: { idempotencyKey: string; maxAttempts: number },
  ): Promise<ProviderResult<{ jobId: string; duplicate: boolean }>>;
  cancel(jobId: string): Promise<ProviderResult<void>>;
}
export interface VirusScannerProvider extends Provider {
  scan(
    input: Uint8Array,
  ): Promise<ProviderResult<{ status: 'clean' | 'infected' | 'inconclusive'; signature?: string }>>;
}
export interface Clock {
  now(): Date;
}

export interface CaseRepository {
  list(
    tenantId: TenantId,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: CaseSummary[]; nextCursor: string | null }>;
  get(tenantId: TenantId, caseId: CaseId): Promise<CaseDetail | null>;
  save(record: CaseDetail, expectedVersion?: number): Promise<CaseDetail>;
}
export interface DomainPackRepository<TPack = unknown> {
  get(id: string, version: string): Promise<TPack | null>;
  save(pack: TPack): Promise<void>;
}
export interface AuditRepository<TEvent = unknown> {
  append(event: TEvent): Promise<void>;
  list(tenantId: TenantId, caseId: CaseId): Promise<TEvent[]>;
}
export interface DocumentBinaryRepository {
  findByHash(tenantId: TenantId, sha256: string): Promise<{ documentId: DocumentId } | null>;
  recordUpload(event: {
    tenantId: TenantId;
    documentId: DocumentId;
    sha256: string;
    duplicateOf: DocumentId | null;
  }): Promise<void>;
}
export interface JobRepository {
  getByIdempotencyKey(tenantId: TenantId, key: string): Promise<Job | null>;
  save(job: Job): Promise<void>;
}

export const ok = <T>(value: T, meta?: ProviderMeta): ProviderResult<T> =>
  meta ? { ok: true, value, meta } : { ok: true, value };
export const fail = (
  code: ProviderErrorCode,
  message: string,
  retryable = false,
  extra: Pick<ProviderError, 'retryAfterMs' | 'cause'> = {},
): ProviderResult<never> => ({ ok: false, error: { code, message, retryable, ...extra } });
