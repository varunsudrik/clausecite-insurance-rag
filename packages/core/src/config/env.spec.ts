import { describe, expect, it } from 'vitest';
import { authEnv, llmEnv, loadEnv, rabbitEnv, redisEnv, retrievalEnv } from './env.js';

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

  it('treats empty values as unset so defaults apply', () => {
    expect(loadEnv(retrievalEnv, { RERANK_THRESHOLD: '' }).RERANK_THRESHOLD).toBe(0.2);
    expect(loadEnv(retrievalEnv, { RERANK_THRESHOLD: '   ' }).RERANK_THRESHOLD).toBe(0.2);
    expect(loadEnv(authEnv, { JWT_SECRET: 'x'.repeat(32), API_KEY: '' }).API_KEY).toBeUndefined();
  });

  it('parses retry delays with whitespace and rejects non-numeric entries', () => {
    expect(
      loadEnv(rabbitEnv, { RABBITMQ_URL: 'amqp://x', INGEST_RETRY_DELAYS_MS: '1, 2' })
        .INGEST_RETRY_DELAYS_MS,
    ).toEqual([1, 2]);
    expect(() =>
      loadEnv(rabbitEnv, { RABBITMQ_URL: 'amqp://x', INGEST_RETRY_DELAYS_MS: '10,abc' }),
    ).toThrow(/Invalid environment/);
  });

  it('treats CACHE_REDIS_URL as optional and an empty value as unset', () => {
    expect(loadEnv(redisEnv, { REDIS_URL: 'redis://a' }).CACHE_REDIS_URL).toBeUndefined();
    expect(
      loadEnv(redisEnv, { REDIS_URL: 'redis://a', CACHE_REDIS_URL: '' }).CACHE_REDIS_URL,
    ).toBeUndefined();
    expect(
      loadEnv(redisEnv, { REDIS_URL: 'redis://a', CACHE_REDIS_URL: 'redis://b' }).CACHE_REDIS_URL,
    ).toBe('redis://b');
  });

  it('throws a readable error listing the missing variable', () => {
    expect(() => loadEnv(authEnv, {})).toThrow(/Invalid environment[\s\S]*JWT_SECRET/);
  });
});
