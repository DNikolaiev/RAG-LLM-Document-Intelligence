import { z } from 'zod';

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

export const appConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_MODE: z.enum(['demo', 'production']).default('demo'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
    WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PUBLIC_API_URL: z.url().default('http://localhost:4100'),
    DATABASE_URL: optionalUrl,
    REDIS_URL: optionalUrl,
    S3_ENDPOINT: optionalUrl,
    S3_REGION: z.string().min(1).default('eu-central-1'),
    S3_BUCKET: z.string().min(1).default('caselens'),
    S3_ACCESS_KEY: optionalSecret,
    S3_SECRET_KEY: optionalSecret,
    MODEL_PROVIDER: z
      .enum(['deterministic', 'openai-compatible', 'anthropic-compatible'])
      .default('deterministic'),
    MODEL_NAME: z.string().min(1).default('deterministic-v1'),
    MODEL_BASE_URL: optionalUrl,
    MODEL_API_KEY: optionalSecret,
    EMBEDDING_PROVIDER: z.enum(['deterministic', 'openai-compatible']).default('deterministic'),
    OCR_PROVIDER: z.enum(['deterministic', 'http']).default('deterministic'),
    OCR_BASE_URL: optionalUrl,
    OCR_API_KEY: optionalSecret,
    STORAGE_PROVIDER: z.enum(['memory', 'filesystem', 's3']).default('memory'),
    SEARCH_PROVIDER: z.enum(['memory', 'postgres']).default('memory'),
    QUEUE_PROVIDER: z.enum(['memory', 'bullmq']).default('memory'),
    PERSISTENCE_PROVIDER: z.enum(['memory', 'postgres']).default('memory'),
    SCANNER_PROVIDER: z.enum(['deterministic', 'http']).default('deterministic'),
    DEMO_TENANT_ID: z.string().min(1).default('tenant_demo'),
    AUTH_MODE: z.enum(['demo', 'oidc']).default('demo'),
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
