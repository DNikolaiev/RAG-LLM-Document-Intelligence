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
});
