import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { EmbeddingModel, LanguageModel } from 'ai';
import type { LlmEnv } from '../config/env.js';

export interface Models {
  chat: LanguageModel;
  rewrite: LanguageModel;
  embedding: EmbeddingModel;
  ids: { chat: string; embedding: string; rerank: string };
}

export function createModels(env: LlmEnv): Models {
  const openrouter = createOpenRouter({
    apiKey: env.OPENROUTER_API_KEY,
    baseURL: env.OPENROUTER_BASE_URL,
    compatibility: 'strict',
    appName: 'ClauseCite',
  });
  return {
    chat: openrouter.chat(env.CHAT_MODEL, {
      models: env.CHAT_FALLBACK_MODELS,
      usage: { include: true },
    }),
    rewrite: openrouter.chat(env.REWRITE_MODEL ?? env.CHAT_MODEL, { usage: { include: true } }),
    embedding: openrouter.textEmbeddingModel(env.EMBEDDING_MODEL),
    ids: { chat: env.CHAT_MODEL, embedding: env.EMBEDDING_MODEL, rerank: env.RERANK_MODEL },
  };
}
