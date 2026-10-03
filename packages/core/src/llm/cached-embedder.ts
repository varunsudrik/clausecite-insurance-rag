import { createHash } from 'node:crypto';
import type { EmbeddingModel } from 'ai';
import { embedQuery } from './embed.js';

export interface KeyValueCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
}

const normalize = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim();

const isVector = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

export function createCachedQueryEmbedder(
  model: EmbeddingModel,
  modelId: string,
  cache: KeyValueCache,
  opts: { ttlSeconds?: number; onHit?(): void; onMiss?(): void } = {},
): (query: string) => Promise<number[]> {
  const ttl = opts.ttlSeconds ?? 7 * 24 * 3600;

  // The cache is an optimization: any failure (cache down, corrupt or unparsable entry) is a miss.
  const lookup = async (key: string): Promise<number[] | null> => {
    try {
      const cached = await cache.get(key);
      if (!cached) return null;
      const parsed: unknown = JSON.parse(cached);
      return isVector(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  return async (query) => {
    const key = `emb:${modelId}:${createHash('sha256').update(normalize(query)).digest('hex')}`;
    const cached = await lookup(key);
    if (cached) {
      opts.onHit?.();
      return cached;
    }
    opts.onMiss?.();
    const embedding = await embedQuery(model, query);
    try {
      await cache.set(key, JSON.stringify(embedding), ttl);
    } catch {
      // best effort
    }
    return embedding;
  };
}
