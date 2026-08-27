import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeterministicModelProvider,
  MemoryJobQueueProvider,
  MemoryObjectStorageProvider,
  MemoryVectorSearchProvider,
  PgVectorSearchProvider,
  OpenAiCompatibleProvider,
  HttpDocumentTextProvider,
  ProviderRegistry,
  type ModelProvider,
} from '../src/index.js';
import { z } from 'zod';

afterEach(() => vi.unstubAllGlobals());

describe('provider registry', () => {
  it('validates duplicate, unknown, capability, and ordered fallback selection', () => {
    const registry = new ProviderRegistry().register(new DeterministicModelProvider());
    expect(() => registry.register(new DeterministicModelProvider())).toThrow('already registered');
    expect(() => registry.resolve('unknown')).toThrow('Unknown provider');
    expect(() => registry.resolve('deterministic-model', ['speech'])).toThrow('lacks capabilities');
    expect(
      registry
        .select<ModelProvider>(['missing', 'deterministic-model'], ['embeddings'])
        .capabilities().id,
    ).toBe('deterministic-model');
  });
});

describe('deterministic adapters', () => {
  it('schema-validates model fixtures and creates repeatable embeddings', async () => {
    const provider = new DeterministicModelProvider({ invoice: { total: 42 } });
    const valid = await provider.generateStructured({
      system: '',
      prompt: '',
      schema: z.object({ total: z.number() }),
      schemaName: 'invoice',
      timeoutMs: 10,
    });
    const invalid = await provider.generateStructured({
      system: '',
      prompt: '',
      schema: z.object({ total: z.string() }),
      schemaName: 'invoice',
      timeoutMs: 10,
    });
    expect(valid).toMatchObject({ ok: true, value: { total: 42 } });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    const embeddings = await provider.embed(['GDP policy', 'GDP policy']);
    expect(embeddings).toMatchObject({ ok: true });
    if (embeddings.ok) expect(embeddings.value[0]).toEqual(embeddings.value[1]);
  });

  it('provides immutable storage and idempotent queues', async () => {
    const storage = new MemoryObjectStorageProvider();
    const bytes = new Uint8Array([1, 2, 3]);
    expect((await storage.put('a', bytes)).ok).toBe(true);
    bytes[0] = 9;
    const stored = await storage.get('a');
    expect(stored.ok && [...stored.value]).toEqual([1, 2, 3]);
    expect(await storage.put('a', bytes)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const queue = new MemoryJobQueueProvider();
    const first = await queue.enqueue('process', {}, { idempotencyKey: 'same', maxAttempts: 3 });
    const second = await queue.enqueue('process', {}, { idempotencyKey: 'same', maxAttempts: 3 });
    expect(first.ok && second.ok && second.value.jobId).toBe(first.ok ? first.value.jobId : '');
    expect(second).toMatchObject({ ok: true, value: { duplicate: true } });
  });

  it('never returns another tenant, stale, revoked, or wrong pack policy', async () => {
    const search = new MemoryVectorSearchProvider();
    const base = {
      domainId: 'legal',
      packVersion: '1.0.0',
      documentId: 'doc',
      documentVersion: '1',
      collectionId: 'policy',
      text: 'minimum liability coverage',
      embedding: [1, 0],
      validFrom: '2025-01-01T00:00:00Z',
      validTo: null,
      revokedAt: null,
      tags: [],
    };
    await search.index([
      { ...base, id: 'allowed', tenantId: 'tenant-a' },
      { ...base, id: 'cross-tenant', tenantId: 'tenant-b' },
      { ...base, id: 'revoked', tenantId: 'tenant-a', revokedAt: '2026-01-01T00:00:00Z' },
      { ...base, id: 'expired', tenantId: 'tenant-a', validTo: '2025-02-01T00:00:00Z' },
    ]);
    const result = await search.search({
      text: 'liability',
      embedding: [1, 0],
      limit: 10,
      scope: {
        tenantId: 'tenant-a',
        domainId: 'legal',
        packVersion: '1.0.0',
        at: '2026-08-26T00:00:00Z',
      },
    });
    expect(result.ok && result.value.map((hit) => hit.chunk.id)).toEqual(['allowed']);
  });
});

describe('PostgreSQL vector adapter boundaries', () => {
  it('rejects embeddings that do not match the configured vector dimension before querying', async () => {
    const provider = new PgVectorSearchProvider({
      id: 'postgres-search',
      connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
      dimensions: 3,
    });
    const result = await provider.search({
      text: 'policy',
      embedding: [1, 0],
      limit: 5,
      scope: {
        tenantId: 'tenant-a',
        domainId: 'supplier',
        packVersion: '1.0.0',
        at: '2026-08-26T00:00:00Z',
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
  });
});

describe('HTTP provider error normalization', () => {
  it('sends portable JSON-schema and reasoning controls when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"total":42}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiCompatibleProvider({
      id: 'local-model',
      baseUrl: 'http://model/v1',
      apiKey: 'local',
      chatModel: 'chat',
      embeddingModel: 'embed',
      reasoningEffort: 'none',
      maxOutputTokens: 512,
      structuredOutputMode: 'json-schema',
    });
    await expect(
      provider.generateStructured({
        system: 'Extract facts.',
        prompt: 'Invoice total',
        schema: z.object({ total: z.number() }),
        schemaName: 'invoice',
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({ ok: true, value: { total: 42 } });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      reasoning_effort: 'none',
      max_tokens: 512,
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name: 'invoice', strict: true } },
    });
  });

  it('uses Ollama native JSON mode without leaking the validation schema into the prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: { content: '{"total":42}' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiCompatibleProvider({
      id: 'local-ollama',
      baseUrl: 'http://ollama:11434/v1',
      apiKey: 'local',
      chatModel: 'qwen3:4b',
      embeddingModel: 'embeddinggemma:300m-qat-q4_0',
      chatApiStyle: 'ollama-native',
      structuredOutputMode: 'json-object',
      includeSchemaInPrompt: false,
      maxOutputTokens: 768,
    });

    await expect(
      provider.generateStructured({
        system: 'Extract facts.',
        prompt: 'Return the invoice total.',
        schema: z.object({ total: z.number() }),
        schemaName: 'invoice',
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({ ok: true, value: { total: 42 } });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://ollama:11434/api/chat');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      model: 'qwen3:4b',
      format: 'json',
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 768 },
    });
    expect(body.messages[1].content).toBe('Return the invoice total.');
  });

  it('validates page-aware native extraction responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            pages: [{ page: 1, text: 'Contract text', rotation: 0, language: null, confidence: 1 }],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );
    const provider = new HttpDocumentTextProvider({
      id: 'local-text',
      endpoint: 'http://ocr/v1/text',
    });
    await expect(provider.extract(new Uint8Array([1]), 'application/pdf')).resolves.toMatchObject({
      ok: true,
      value: [{ page: 1, text: 'Contract text' }],
    });
  });

  it.each([
    [429, 'rate_limited'],
    [503, 'unavailable'],
    [400, 'invalid_response'],
  ] as const)('maps HTTP %s', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    const provider = new OpenAiCompatibleProvider({
      id: 'test',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'x',
      chatModel: 'chat',
      embeddingModel: 'embed',
    });
    expect(
      await provider.generateStructured({
        system: '',
        prompt: '',
        schema: z.object({ ok: z.boolean() }),
        schemaName: 'result',
        timeoutMs: 10,
      }),
    ).toMatchObject({ ok: false, error: { code } });
  });

  it('rejects malformed successful responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"wrong":true}' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const provider = new OpenAiCompatibleProvider({
      id: 'test',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'x',
      chatModel: 'chat',
      embeddingModel: 'embed',
    });
    expect(
      await provider.generateStructured({
        system: '',
        prompt: '',
        schema: z.object({ ok: z.boolean() }),
        schemaName: 'result',
        timeoutMs: 10,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
  });
});
