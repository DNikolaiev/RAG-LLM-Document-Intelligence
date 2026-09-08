import { z } from 'zod';

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);
const environmentBoolean = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.toLocaleLowerCase() : value),
    z.union([z.literal(true), z.literal(false), z.literal('true'), z.literal('false')]),
  )
  .transform((value) => value === true || value === 'true');

export const appConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_MODE: z.enum(['demo', 'production']).default('demo'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
    WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PUBLIC_API_URL: z.url().default('http://localhost:4100'),
    DATABASE_URL: optionalUrl,
    REDIS_URL: optionalUrl,
    // The event backbone. Distinct from REDIS_URL, which carries commands: this carries facts,
    // published once and fanned out to whichever services have bound a queue.
    RABBITMQ_URL: optionalUrl,
    EVENT_RELAY_ENABLED: environmentBoolean.default(false),
    EVENT_RELAY_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
    EVENT_RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    ANALYTICS_QUEUE_NAME: z.string().min(1).default('analytics.events'),
    // How many unacknowledged deliveries the broker may hold in flight for one consumer. Left
    // modest on purpose: the queue is the right place for a backlog to wait, not the consumer's
    // heap.
    ANALYTICS_PREFETCH: z.coerce.number().int().min(1).max(1000).default(16),
    S3_ENDPOINT: optionalUrl,
    S3_REGION: z.string().min(1).default('eu-central-1'),
    S3_BUCKET: z.string().min(1).default('caselens'),
    S3_ACCESS_KEY: optionalSecret,
    S3_SECRET_KEY: optionalSecret,
    MODEL_PROVIDER: z
      .enum(['deterministic', 'openai-compatible', 'anthropic-compatible'])
      .default('deterministic'),
    MODEL_NAME: z.string().min(1).default('deterministic-v1'),
    MODEL_API_STYLE: z.enum(['openai', 'ollama-native']).default('openai'),
    MODEL_STRUCTURED_OUTPUT_MODE: z.enum(['json-object', 'json-schema']).default('json-schema'),
    MODEL_INCLUDE_SCHEMA_IN_PROMPT: environmentBoolean.default(true),
    EMBEDDING_MODEL: z.string().min(1).default('deterministic-embedding-v1'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(4096).default(768),
    MODEL_BASE_URL: optionalUrl,
    MODEL_API_KEY: optionalSecret,
    EMBEDDING_PROVIDER: z.enum(['deterministic', 'openai-compatible']).default('deterministic'),
    EMBEDDING_BASE_URL: optionalUrl,
    EMBEDDING_API_KEY: optionalSecret,
    OCR_PROVIDER: z.enum(['deterministic', 'http']).default('deterministic'),
    OCR_BASE_URL: optionalUrl,
    OCR_API_KEY: optionalSecret,
    STORAGE_PROVIDER: z.enum(['memory', 'filesystem', 's3']).default('memory'),
    SEARCH_PROVIDER: z.enum(['memory', 'postgres']).default('memory'),
    QUEUE_PROVIDER: z.enum(['memory', 'bullmq']).default('memory'),
    QUEUE_NAME: z.string().min(1).default('caselens-processing'),
    PERSISTENCE_PROVIDER: z.enum(['memory', 'postgres']).default('memory'),
    SCANNER_PROVIDER: z.enum(['deterministic', 'http']).default('deterministic'),
    DEMO_TENANT_ID: z.string().min(1).default('tenant_demo'),
    AUTH_MODE: z.enum(['demo', 'test-profiles', 'oidc']).default('demo'),
    ENABLE_TEST_IDENTITY_SWITCHER: environmentBoolean.default(false),
    FIXTURE_POLICY_CATALOG_ENABLED: environmentBoolean.default(false),
    WORKER_CHUNK_CHARACTERS: z.coerce.number().int().min(1_000).max(20_000).default(6_000),
    WORKER_CHUNK_OVERLAP: z.coerce.number().int().min(0).max(2_000).default(300),
    WORKER_MAX_EXTRACTION_CHUNKS: z.coerce.number().int().min(1).max(512).default(48),
    WORKER_MAX_DOCUMENTS: z.coerce.number().int().min(1).max(256).default(32),
    // CPU-local models are usually fastest and most reliable with one request at a time.
    // Deployments with dedicated model capacity may raise these independently.
    WORKER_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    WORKER_MODEL_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    WORKER_MODEL_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(600_000).default(300_000),
    WORKER_POLICY_MODEL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(600_000)
      .default(300_000),
    // Cosine similarity a recalled field must reach before the chat model is asked whether a
    // proposed field means the same thing. Lower it to catch more duplicates at the cost of more
    // model calls; raise it to mint new fields more readily.
    // A recall guard, not a decision boundary: measured synonym and unrelated-field similarity
    // bands overlap, so the model decides. Above ~0.5 real duplicates stop reaching it.
    WORKER_FIELD_DEDUP_SIMILARITY_FLOOR: z.coerce.number().min(0).max(1).default(0.4),
  })
  .superRefine((config, context) => {
    const required = (condition: boolean, value: unknown, path: string, message: string) => {
      if (condition && !value) {
        context.addIssue({ code: 'custom', path: [path], message });
      }
    };

    required(
      config.PERSISTENCE_PROVIDER === 'postgres',
      config.DATABASE_URL,
      'DATABASE_URL',
      'Required for PostgreSQL persistence',
    );
    required(
      config.SEARCH_PROVIDER === 'postgres',
      config.DATABASE_URL,
      'DATABASE_URL',
      'Required for PostgreSQL search',
    );
    required(
      config.QUEUE_PROVIDER === 'bullmq',
      config.REDIS_URL,
      'REDIS_URL',
      'Required for BullMQ',
    );
    required(
      config.EVENT_RELAY_ENABLED,
      config.RABBITMQ_URL,
      'RABBITMQ_URL',
      'Required to publish domain events',
    );
    required(
      config.STORAGE_PROVIDER === 's3',
      config.S3_ENDPOINT,
      'S3_ENDPOINT',
      'Required for S3 storage',
    );
    required(
      config.STORAGE_PROVIDER === 's3',
      config.S3_ACCESS_KEY,
      'S3_ACCESS_KEY',
      'Required for S3 storage',
    );
    required(
      config.STORAGE_PROVIDER === 's3',
      config.S3_SECRET_KEY,
      'S3_SECRET_KEY',
      'Required for S3 storage',
    );
    required(
      config.MODEL_PROVIDER !== 'deterministic',
      config.MODEL_BASE_URL,
      'MODEL_BASE_URL',
      'Required for an external model',
    );
    const embeddingBaseUrl =
      config.EMBEDDING_BASE_URL ??
      (config.MODEL_PROVIDER === 'openai-compatible' ? config.MODEL_BASE_URL : undefined);
    const embeddingApiKey =
      config.EMBEDDING_API_KEY ??
      (config.MODEL_PROVIDER === 'openai-compatible' ? config.MODEL_API_KEY : undefined);
    required(
      config.EMBEDDING_PROVIDER === 'openai-compatible',
      embeddingBaseUrl,
      'EMBEDDING_BASE_URL',
      'Required for an external embedding model',
    );
    required(
      config.EMBEDDING_PROVIDER === 'openai-compatible',
      embeddingApiKey,
      'EMBEDDING_API_KEY',
      'Required for an external embedding model',
    );
    required(
      config.MODEL_PROVIDER !== 'deterministic',
      config.MODEL_API_KEY,
      'MODEL_API_KEY',
      'Required for an external model',
    );
    required(
      config.OCR_PROVIDER === 'http',
      config.OCR_BASE_URL,
      'OCR_BASE_URL',
      'Required for HTTP OCR',
    );
    if (
      config.APP_MODE === 'production' &&
      !(config.AUTH_MODE === 'test-profiles' && config.ENABLE_TEST_IDENTITY_SWITCHER)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message:
          'The local production runtime requires AUTH_MODE=test-profiles with ENABLE_TEST_IDENTITY_SWITCHER=true; OIDC remains disabled until a verified-token adapter is installed',
      });
    }
    if (config.APP_MODE === 'production') {
      const durableSelections = [
        ['PERSISTENCE_PROVIDER', config.PERSISTENCE_PROVIDER, 'postgres'],
        ['QUEUE_PROVIDER', config.QUEUE_PROVIDER, 'bullmq'],
        ['STORAGE_PROVIDER', config.STORAGE_PROVIDER, 's3'],
        ['SEARCH_PROVIDER', config.SEARCH_PROVIDER, 'postgres'],
      ] as const;
      for (const [path, actual, expected] of durableSelections) {
        if (actual !== expected) {
          context.addIssue({
            code: 'custom',
            path: [path],
            message: `Production requires ${path}=${expected}`,
          });
        }
      }
      if (config.MODEL_PROVIDER === 'deterministic') {
        context.addIssue({
          code: 'custom',
          path: ['MODEL_PROVIDER'],
          message: 'Production requires a non-deterministic model provider',
        });
      }
      if (config.EMBEDDING_PROVIDER !== 'openai-compatible') {
        context.addIssue({
          code: 'custom',
          path: ['EMBEDDING_PROVIDER'],
          message: 'Production requires EMBEDDING_PROVIDER=openai-compatible',
        });
      }
      if (config.OCR_PROVIDER !== 'http') {
        context.addIssue({
          code: 'custom',
          path: ['OCR_PROVIDER'],
          message: 'Production requires OCR_PROVIDER=http',
        });
      }
    }
    if (
      config.MODEL_API_STYLE === 'ollama-native' &&
      config.MODEL_PROVIDER !== 'openai-compatible'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['MODEL_API_STYLE'],
        message: 'MODEL_API_STYLE=ollama-native requires MODEL_PROVIDER=openai-compatible',
      });
    }
    if (config.WORKER_CHUNK_OVERLAP >= config.WORKER_CHUNK_CHARACTERS) {
      context.addIssue({
        code: 'custom',
        path: ['WORKER_CHUNK_OVERLAP'],
        message: 'WORKER_CHUNK_OVERLAP must be smaller than WORKER_CHUNK_CHARACTERS',
      });
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly { path: string; message: string }[]) {
    super(
      `Invalid CaseLens configuration: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = appConfigSchema.safeParse(environment);
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
