import { describe, expect, it } from 'vitest';
import { authEnv, llmEnv, loadEnv, rabbitEnv, retrievalEnv } from './env.js';

describe('loadEnv', () => {
  it('applies model defaults and splits fallback models', () => {
    const env = loadEnv(llmEnv, { OPENROUTER_API_KEY: 'k', CHAT_FALLBACK_MODELS: 'a/b, c/d' });
    expect(env.CHAT_MODEL).toBe('anthropic/claude-haiku-4.5');
    expect(env.EMBEDDING_MODEL).toBe('openai/text-embedding-3-small');
    expect(env.RERANK_MODEL).toBe('cohere/rerank-v3.5');
    expect(env.CHAT_FALLBACK_MODELS).toEqual(['a/b', 'c/d']);
  });

  it('coerces numbers and parses retry delays', () => {
    expect(loadEnv(retrievalEnv, { RERANK_THRESHOLD: '0.35' }).RERANK_THRESHOLD).toBe(0.35);
    expect(loadEnv(rabbitEnv, { RABBITMQ_URL: 'amqp://x' }).INGEST_RETRY_DELAYS_MS).toEqual([
      10000, 60000, 300000,
    ]);
  });

  it('throws a readable error listing the missing variable', () => {
    expect(() => loadEnv(authEnv, {})).toThrow(/Invalid environment[\s\S]*JWT_SECRET/);
  });
});
