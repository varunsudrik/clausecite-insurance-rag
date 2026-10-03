import { createHash } from 'node:crypto';
import type { EmbeddingModel } from 'ai';
import { EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { embedQuery } from './embed.js';

export interface KeyValueCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
}

const normalize = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim();

/** A vector is cacheable (and a cached entry usable) only if it has the schema's dimension and finite values. */
const isValid = (v: ArrayLike<number>): boolean =>
  v.length === EMBEDDING_DIMENSIONS && Array.prototype.every.call(v, Number.isFinite);

/** Little-endian float32, base64: about 8 KB per vector instead of about 25 KB as JSON. */
function encode(vector: number[]): string {
  const buf = Buffer.alloc(vector.length * 4);
  vector.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString('base64');
}

function decode(value: string): number[] | null {
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== EMBEDDING_DIMENSIONS * 4) return null;
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => buf.readFloatLE(i * 4));
  return isValid(vector) ? vector : null;
}

export function createCachedQueryEmbedder(
  model: EmbeddingModel,
  modelId: string,
  cache: KeyValueCache,
  opts: { ttlSeconds?: number; onHit?(): void; onMiss?(): void } = {},
): (query: string) => Promise<number[]> {
  const ttl = opts.ttlSeconds ?? 7 * 24 * 3600;

  // The cache is an optimization: any failure (cache down, wrong-size or corrupt entry) is a miss.
  const lookup = async (key: string): Promise<number[] | null> => {
    try {
      const cached = await cache.get(key);
      return cached ? decode(cached) : null;
    } catch {
      return null;
    }
  };

  return async (query) => {
    const normalized = normalize(query);
    const key = `emb:${modelId}:${createHash('sha256').update(normalized).digest('hex')}`;
    const cached = await lookup(key);
    if (cached) {
      opts.onHit?.();
      return cached;
    }
    opts.onMiss?.();
    // Embed the normalized text (the cache key's input), so the cached vector is the same
    // whichever spelling of the query warmed it.
    const embedding = await embedQuery(model, normalized);
    // Round to float32 (what pgvector stores anyway) so a miss returns exactly what a later hit will.
    const stored = embedding.map(Math.fround);
    if (!isValid(stored)) return embedding;
    try {
      // Fire and forget: a slow or failing cache must never add latency to, or fail, the request.
      void Promise.resolve(cache.set(key, encode(stored), ttl)).catch(() => undefined);
    } catch {
      // cache.set threw synchronously
    }
    return stored;
  };
}
