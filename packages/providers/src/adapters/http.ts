import { z } from 'zod';
import {
  fail,
  ok,
  type ModelProvider,
  type OcrProvider,
  type ProviderCapabilities,
  type ProviderErrorCode,
  type ProviderResult,
  type StructuredGenerationRequest,
  type TextPage,
} from '../ports.js';

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<ProviderResult<unknown>> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const code: ProviderErrorCode =
        response.status === 429
          ? 'rate_limited'
          : response.status >= 500
            ? 'unavailable'
            : 'invalid_response';
      const retryAfter = Number(response.headers.get('retry-after'));
      return fail(
        code,
        `Provider returned HTTP ${response.status}`,
        retryable,
        Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1_000 } : {},
      );
    }
    try {
      return ok(await response.json());
    } catch (error) {
      return fail('invalid_response', 'Provider returned invalid JSON', false, { cause: error });
    }
  } catch (error) {
    return error instanceof DOMException && error.name === 'TimeoutError'
      ? fail('timeout', 'Provider request timed out', true, { cause: error })
      : fail('unavailable', 'Provider request failed', true, { cause: error });
  }
}

export interface OpenAiCompatibleConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
  organization?: string;
}
export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(private readonly config: OpenAiCompatibleConfig) {
    if (!config.baseUrl || !config.apiKey || !config.chatModel || !config.embeddingModel)
      throw new Error('OpenAI-compatible provider is misconfigured');
  }
  capabilities(): ProviderCapabilities {
    return { id: this.config.id, features: ['structured-generation', 'embeddings'] };
  }
  async health(): Promise<ProviderResult<{ status: 'healthy' | 'degraded' }>> {
    return ok({ status: 'healthy' });
  }
  private headers(): HeadersInit {
    return {
      authorization: `Bearer ${this.config.apiKey}`,
      'content-type': 'application/json',
      ...(this.config.organization ? { 'openai-organization': this.config.organization } : {}),
    };
  }
  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<ProviderResult<T>> {
    const result = await requestJson(
      `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.chatModel,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          response_format: { type: 'json_object' },
        }),
      },
      request.timeoutMs,
    );
    if (!result.ok) return result;
    const content = (result.value as { choices?: { message?: { content?: string } }[] })
      .choices?.[0]?.message?.content;
    if (!content) return fail('invalid_response', 'Model response had no content');
    try {
      const parsed = request.schema.safeParse(JSON.parse(content));
      return parsed.success
        ? ok(parsed.data, { providerId: this.config.id, model: this.config.chatModel })
        : fail('invalid_response', `Model output failed ${request.schemaName} validation`);
    } catch (error) {
      return fail('invalid_response', 'Model output was not JSON', false, { cause: error });
    }
  }
  async embed(texts: readonly string[]): Promise<ProviderResult<number[][]>> {
    const result = await requestJson(
      `${this.config.baseUrl.replace(/\/$/, '')}/embeddings`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: this.config.embeddingModel, input: texts }),
      },
      30_000,
    );
    if (!result.ok) return result;
    const values = (result.value as { data?: { embedding?: number[]; index?: number }[] }).data;
    if (!values || values.some((item) => !Array.isArray(item.embedding)))
      return fail('invalid_response', 'Embedding response was invalid');
    return ok(
      [...values].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding!),
      { providerId: this.config.id, model: this.config.embeddingModel },
    );
  }
}

export interface AnthropicCompatibleConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  version?: string;
}
export class AnthropicCompatibleProvider implements ModelProvider {
  constructor(private readonly config: AnthropicCompatibleConfig) {
    if (!config.baseUrl || !config.apiKey || !config.model)
      throw new Error('Anthropic-compatible provider is misconfigured');
  }
  capabilities(): ProviderCapabilities {
    return { id: this.config.id, features: ['structured-generation'] };
  }
  async health(): Promise<ProviderResult<{ status: 'healthy' | 'degraded' }>> {
    return ok({ status: 'healthy' });
  }
  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<ProviderResult<T>> {
    const result = await requestJson(
      `${this.config.baseUrl.replace(/\/$/, '')}/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': this.config.version ?? '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 4096,
          system: request.system,
          messages: [
            {
              role: 'user',
              content: `${request.prompt}\nReturn only JSON for schema ${request.schemaName}.`,
            },
          ],
        }),
      },
      request.timeoutMs,
    );
    if (!result.ok) return result;
    const content = (result.value as { content?: { type: string; text?: string }[] }).content?.find(
      (item) => item.type === 'text',
    )?.text;
    if (!content) return fail('invalid_response', 'Model response had no text content');
    try {
      const parsed = request.schema.safeParse(JSON.parse(content));
      return parsed.success
        ? ok(parsed.data, { providerId: this.config.id, model: this.config.model })
        : fail('invalid_response', `Model output failed ${request.schemaName} validation`);
    } catch (error) {
      return fail('invalid_response', 'Model output was not JSON', false, { cause: error });
    }
  }
  async embed(): Promise<ProviderResult<number[][]>> {
    return fail('unsupported', 'Anthropic-compatible adapter does not provide embeddings');
  }
}

export interface HttpOcrConfig {
  id: string;
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
}
export class HttpOcrProvider implements OcrProvider {
  constructor(private readonly config: HttpOcrConfig) {
    if (!config.endpoint) throw new Error('HTTP OCR provider is misconfigured');
  }
  capabilities(): ProviderCapabilities {
    return { id: this.config.id, features: ['ocr', 'orientation'], languages: ['*'] };
  }
  async health(): Promise<ProviderResult<{ status: 'healthy' | 'degraded' }>> {
    return ok({ status: 'healthy' });
  }
  async recognize(
    input: Uint8Array,
    options: { page: number; rotation?: number; languageHints?: readonly string[] },
  ): Promise<ProviderResult<TextPage>> {
    const result = await requestJson(
      this.config.endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ content: Buffer.from(input).toString('base64'), ...options }),
      },
      this.config.timeoutMs ?? 60_000,
    );
    if (!result.ok) return result;
    const PageSchema: z.ZodType<TextPage> = z.object({
      page: z.number().int().positive(),
      text: z.string(),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      language: z.string().optional(),
      confidence: z.number().min(0).max(1),
      blocks: z
        .array(
          z.object({
            text: z.string(),
            confidence: z.number(),
            boundingBox: z
              .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
              .optional(),
          }),
        )
        .optional(),
    });
    const parsed = PageSchema.safeParse(result.value);
    return parsed.success
      ? ok(parsed.data, { providerId: this.config.id })
      : fail('invalid_response', 'OCR response failed validation');
  }
}
