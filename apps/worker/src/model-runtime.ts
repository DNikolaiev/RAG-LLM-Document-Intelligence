import type { AppConfig } from '@caselens/config';
import {
  AnthropicCompatibleProvider,
  OpenAiCompatibleProvider,
  type ModelProvider,
} from '@caselens/providers';
import { FixturePolicyModelProvider } from './fixture-policy-model.js';

export interface WorkerModelRuntime {
  chat: ModelProvider;
  embeddings: ModelProvider;
}

export function createWorkerModelRuntime(config: AppConfig): WorkerModelRuntime {
  const configuredChat = createChatProvider(config);
  const chat = config.FIXTURE_POLICY_CATALOG_ENABLED
    ? new FixturePolicyModelProvider(configuredChat)
    : configuredChat;
  const embeddings = createEmbeddingProvider(config);
  return { chat, embeddings };
}

function createChatProvider(config: AppConfig): ModelProvider {
  if (config.MODEL_PROVIDER === 'anthropic-compatible') {
    return new AnthropicCompatibleProvider({
      id: 'configured-anthropic-chat',
      baseUrl: config.MODEL_BASE_URL!,
      apiKey: config.MODEL_API_KEY!,
      model: config.MODEL_NAME,
    });
  }
  if (config.MODEL_PROVIDER === 'openai-compatible') {
    return new OpenAiCompatibleProvider({
      id: 'configured-openai-chat',
      baseUrl: config.MODEL_BASE_URL!,
      apiKey: config.MODEL_API_KEY!,
      chatModel: config.MODEL_NAME,
      embeddingModel: config.EMBEDDING_MODEL,
      // Policy proposals include citations and four executable boundary cases. This budget
      // fits a small set of proposals while remaining practical for CPU-only local models.
      maxOutputTokens: 2_048,
      structuredOutputMode: config.MODEL_STRUCTURED_OUTPUT_MODE,
      chatApiStyle: config.MODEL_API_STYLE,
      includeSchemaInPrompt: config.MODEL_INCLUDE_SCHEMA_IN_PROMPT,
    });
  }
  throw new Error(`Unsupported production chat provider: ${config.MODEL_PROVIDER}`);
}

function createEmbeddingProvider(config: AppConfig): ModelProvider {
  if (config.EMBEDDING_PROVIDER !== 'openai-compatible') {
    throw new Error(`Unsupported production embedding provider: ${config.EMBEDDING_PROVIDER}`);
  }
  const reuseChatConnection = config.MODEL_PROVIDER === 'openai-compatible';
  return new OpenAiCompatibleProvider({
    id: 'configured-openai-embeddings',
    baseUrl: config.EMBEDDING_BASE_URL ?? (reuseChatConnection ? config.MODEL_BASE_URL! : ''),
    apiKey: config.EMBEDDING_API_KEY ?? (reuseChatConnection ? config.MODEL_API_KEY! : ''),
    chatModel: config.MODEL_NAME,
    embeddingModel: config.EMBEDDING_MODEL,
  });
}
