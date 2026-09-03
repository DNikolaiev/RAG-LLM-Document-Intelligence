import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from './index.js';

describe('loadConfig', () => {
  it('starts in deterministic demo mode without credentials', () => {
    expect(loadConfig({})).toMatchObject({
      APP_MODE: 'demo',
      MODEL_PROVIDER: 'deterministic',
      PERSISTENCE_PROVIDER: 'memory',
    });
  });

  it('coerces the field dedup similarity floor and holds it inside the unit interval', () => {
    expect(loadConfig({}).WORKER_FIELD_DEDUP_SIMILARITY_FLOOR).toBe(0.4);
    expect(loadConfig({ WORKER_FIELD_DEDUP_SIMILARITY_FLOOR: '0.6' })).toMatchObject({
      WORKER_FIELD_DEDUP_SIMILARITY_FLOOR: 0.6,
    });
    expect(() => loadConfig({ WORKER_FIELD_DEDUP_SIMILARITY_FLOOR: '1.4' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ WORKER_FIELD_DEDUP_SIMILARITY_FLOOR: 'most' })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects an incomplete provider switch at startup', () => {
    expect(() => loadConfig({ MODEL_PROVIDER: 'openai-compatible' })).toThrow(ConfigurationError);
  });

  it('accepts independently selected external providers', () => {
    expect(
      loadConfig({
        MODEL_PROVIDER: 'anthropic-compatible',
        MODEL_BASE_URL: 'https://model.example.test',
        MODEL_API_KEY: 'secret',
        OCR_PROVIDER: 'http',
        OCR_BASE_URL: 'https://ocr.example.test',
      }),
    ).toMatchObject({ MODEL_PROVIDER: 'anthropic-compatible', OCR_PROVIDER: 'http' });
  });

  it('rejects production when the local identity switcher is not explicitly enabled', () => {
    expect(() =>
      loadConfig({
        APP_MODE: 'production',
        AUTH_MODE: 'test-profiles',
        PERSISTENCE_PROVIDER: 'postgres',
        DATABASE_URL: 'postgresql://app:secret@postgres/caselens',
        QUEUE_PROVIDER: 'bullmq',
        REDIS_URL: 'redis://:secret@redis:6379',
        STORAGE_PROVIDER: 's3',
        S3_ENDPOINT: 'http://minio:9000',
        S3_ACCESS_KEY: 'app',
        S3_SECRET_KEY: 'secret',
        SEARCH_PROVIDER: 'postgres',
        MODEL_PROVIDER: 'openai-compatible',
        MODEL_BASE_URL: 'http://ollama:11434/v1',
        MODEL_API_KEY: 'ollama',
        EMBEDDING_PROVIDER: 'openai-compatible',
        OCR_PROVIDER: 'http',
        OCR_BASE_URL: 'http://ocr:8080/v1/ocr',
      }),
    ).toThrow(ConfigurationError);
  });

  it('rejects OIDC mode until a verified-token adapter is installed', () => {
    expect(() =>
      loadConfig({
        APP_MODE: 'production',
        AUTH_MODE: 'oidc',
        PERSISTENCE_PROVIDER: 'postgres',
        DATABASE_URL: 'postgresql://app:secret@postgres/caselens',
        QUEUE_PROVIDER: 'bullmq',
        REDIS_URL: 'redis://:secret@redis:6379',
        STORAGE_PROVIDER: 's3',
        S3_ENDPOINT: 'http://minio:9000',
        S3_ACCESS_KEY: 'app',
        S3_SECRET_KEY: 'secret',
        SEARCH_PROVIDER: 'postgres',
        MODEL_PROVIDER: 'openai-compatible',
        MODEL_BASE_URL: 'http://ollama:11434/v1',
        MODEL_API_KEY: 'ollama',
        OCR_PROVIDER: 'http',
        OCR_BASE_URL: 'http://ocr:8080/v1/ocr',
      }),
    ).toThrow(/OIDC remains disabled/);
  });

  it('accepts the complete production-like local provider composition', () => {
    expect(
      loadConfig({
        APP_MODE: 'production',
        AUTH_MODE: 'test-profiles',
        ENABLE_TEST_IDENTITY_SWITCHER: 'true',
        PERSISTENCE_PROVIDER: 'postgres',
        DATABASE_URL: 'postgresql://app:secret@postgres/caselens',
        QUEUE_PROVIDER: 'bullmq',
        REDIS_URL: 'redis://:secret@redis:6379',
        STORAGE_PROVIDER: 's3',
        S3_ENDPOINT: 'http://minio:9000',
        S3_ACCESS_KEY: 'app',
        S3_SECRET_KEY: 'secret',
        SEARCH_PROVIDER: 'postgres',
        MODEL_PROVIDER: 'openai-compatible',
        MODEL_BASE_URL: 'http://ollama:11434/v1',
        MODEL_API_KEY: 'ollama',
        MODEL_NAME: 'qwen3:4b',
        MODEL_API_STYLE: 'ollama-native',
        MODEL_STRUCTURED_OUTPUT_MODE: 'json-object',
        MODEL_INCLUDE_SCHEMA_IN_PROMPT: 'false',
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_MODEL: 'embeddinggemma:300m-qat-q4_0',
        OCR_PROVIDER: 'http',
        OCR_BASE_URL: 'http://ocr:8080/v1/ocr',
      }),
    ).toMatchObject({
      APP_MODE: 'production',
      AUTH_MODE: 'test-profiles',
      ENABLE_TEST_IDENTITY_SWITCHER: true,
      EMBEDDING_DIMENSIONS: 768,
      MODEL_API_STYLE: 'ollama-native',
      MODEL_INCLUDE_SCHEMA_IN_PROMPT: false,
    });
  });

  it('requires independent embedding configuration for non-OpenAI chat providers', () => {
    expect(() =>
      loadConfig({
        MODEL_PROVIDER: 'anthropic-compatible',
        MODEL_BASE_URL: 'https://anthropic.example.test',
        MODEL_API_KEY: 'chat-secret',
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_MODEL: 'embed-v1',
      }),
    ).toThrow(/EMBEDDING_BASE_URL/);

    expect(
      loadConfig({
        MODEL_PROVIDER: 'anthropic-compatible',
        MODEL_BASE_URL: 'https://anthropic.example.test',
        MODEL_API_KEY: 'chat-secret',
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_MODEL: 'embed-v1',
        EMBEDDING_BASE_URL: 'https://embeddings.example.test/v1',
        EMBEDDING_API_KEY: 'embedding-secret',
      }),
    ).toMatchObject({
      MODEL_PROVIDER: 'anthropic-compatible',
      EMBEDDING_PROVIDER: 'openai-compatible',
    });
  });

  it('rejects an invalid worker chunk overlap', () => {
    expect(() =>
      loadConfig({ WORKER_CHUNK_CHARACTERS: '1000', WORKER_CHUNK_OVERLAP: '1000' }),
    ).toThrow(/WORKER_CHUNK_OVERLAP/);
  });
});
