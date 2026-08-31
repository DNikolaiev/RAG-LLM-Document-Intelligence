import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@caselens/config';
import { createWorkerModelRuntime } from '../src/model-runtime.js';
import { z } from 'zod';

afterEach(() => vi.unstubAllGlobals());

describe('worker model provider composition', () => {
  it('uses Ollama native JSON mode only when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: { content: '{"ok":true}' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createWorkerModelRuntime(
      loadConfig({
        MODEL_PROVIDER: 'openai-compatible',
        MODEL_BASE_URL: 'http://ollama:11434/v1',
        MODEL_API_KEY: 'ollama',
        MODEL_NAME: 'qwen3:4b',
        MODEL_API_STYLE: 'ollama-native',
        MODEL_STRUCTURED_OUTPUT_MODE: 'json-object',
        MODEL_INCLUDE_SCHEMA_IN_PROMPT: 'false',
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_MODEL: 'embeddinggemma',
      }),
    );

    await expect(
      runtime.chat.generateStructured({
        system: 'Return data.',
        prompt: 'Return {"ok":true}.',
        schema: z.object({ ok: z.boolean() }),
        schemaName: 'native_result',
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ ok: true, value: { ok: true } });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://ollama:11434/api/chat');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      format: 'json',
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 2_048 },
    });
    expect(body.messages[1].content).not.toContain('Return JSON matching this schema');
  });

  it('composes Anthropic chat and an independent OpenAI-compatible embedding endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createWorkerModelRuntime(
      loadConfig({
        MODEL_PROVIDER: 'anthropic-compatible',
        MODEL_BASE_URL: 'https://chat.example.test',
        MODEL_API_KEY: 'chat-secret',
        MODEL_NAME: 'chat-model',
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_BASE_URL: 'https://embed.example.test/v1',
        EMBEDDING_API_KEY: 'embed-secret',
        EMBEDDING_MODEL: 'embed-model',
      }),
    );

    await runtime.chat.generateStructured({
      system: 'Return data.',
      prompt: 'Return JSON.',
      schema: z.object({ ok: z.boolean() }),
      schemaName: 'chat_result',
      timeoutMs: 1_000,
    });
    await runtime.embeddings.embed(['policy']);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chat.example.test/messages');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://embed.example.test/v1/embeddings');
  });
});
