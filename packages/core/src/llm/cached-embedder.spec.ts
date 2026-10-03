import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { mockEmbeddingModel } from '../testing/mock-models.js';
import { createCachedQueryEmbedder, type KeyValueCache } from './cached-embedder.js';

const memoryCache = (): KeyValueCache & { store: Map<string, string> } => {
  const store = new Map<string, string>();
  return { store, get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v) };
};

const toBase64 = (values: number[]) => {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString('base64');
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('createCachedQueryEmbedder', () => {
  it('embeds once per normalized query and serves repeats from cache', async () => {
    const model = mockEmbeddingModel();
    const cache = memoryCache();
    let hits = 0;
    const embed = createCachedQueryEmbedder(model, 'm1', cache, { onHit: () => hits++ });
    const a = await embed('Cataract  waiting period');
    const b = await embed('  cataract waiting PERIOD ');
    expect(b).toEqual(a);
    expect(model.doEmbedCalls).toHaveLength(1);
    expect(hits).toBe(1);
    expect([...cache.store.keys()][0]).toMatch(/^emb:m1:[0-9a-f]{64}$/);
  });

  it('embeds the normalized query so the cached vector does not depend on who warmed the key', async () => {
    const model = mockEmbeddingModel();
    await createCachedQueryEmbedder(model, 'm1', memoryCache())('  Cataract  WAITING   period ');
    expect(model.doEmbedCalls[0].values).toEqual(['cataract waiting period']);
  });

  it('falls through to the model when the cache errors', async () => {
    const model = mockEmbeddingModel();
    const broken: KeyValueCache = {
      get: async () => {
        throw new Error('redis down');
      },
      set: async () => {
        throw new Error('redis down');
      },
    };
    const embed = createCachedQueryEmbedder(model, 'm1', broken);
    expect(await embed('room rent')).toHaveLength(1536);
  });

  it('stores a compact base64 float32 entry and reads it back within float32 precision', async () => {
    const raw = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(i + 1) / 3);
    const model = mockEmbeddingModel(() => raw);
    const cache = memoryCache();
    const embed = createCachedQueryEmbedder(model, 'm1', cache);
    const first = await embed('room rent');
    const stored = [...cache.store.values()][0];
    expect(Buffer.from(stored, 'base64')).toHaveLength(EMBEDDING_DIMENSIONS * 4);
    expect(stored.length).toBeLessThan(EMBEDDING_DIMENSIONS * 6);
    const second = await embed('room rent');
    expect(model.doEmbedCalls).toHaveLength(1);
    expect(second).toEqual(first);
    raw.forEach((v, i) => {
      expect(Math.abs(second[i] - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -23);
    });
  });

  it('treats a cached entry of the wrong length as a miss and overwrites it', async () => {
    const model = mockEmbeddingModel();
    const cache = memoryCache();
    let hits = 0;
    const embed = createCachedQueryEmbedder(model, 'm1', cache, { onHit: () => hits++ });
    await embed('room rent');
    const [key] = [...cache.store.keys()];
    cache.store.set(key, toBase64([0.1, 0.2, 0.3]));
    expect(await embed('room rent')).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(model.doEmbedCalls).toHaveLength(2);
    expect(hits).toBe(0);
    expect(Buffer.from(cache.store.get(key) ?? '', 'base64')).toHaveLength(
      EMBEDDING_DIMENSIONS * 4,
    );
  });

  it('treats a cached entry with a non-finite value as a miss and overwrites it', async () => {
    const model = mockEmbeddingModel();
    const cache = memoryCache();
    const embed = createCachedQueryEmbedder(model, 'm1', cache);
    await embed('room rent');
    const [key] = [...cache.store.keys()];
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const values = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5);
      values[7] = bad;
      cache.store.set(key, toBase64(values));
      const out = await embed('room rent');
      expect(out.every(Number.isFinite)).toBe(true);
      expect(Buffer.from(cache.store.get(key) ?? '', 'base64').readFloatLE(7 * 4)).not.toBe(bad);
    }
    expect(model.doEmbedCalls).toHaveLength(3);
  });

  it('treats garbage and legacy JSON entries as a miss', async () => {
    const model = mockEmbeddingModel();
    const cache = memoryCache();
    const embed = createCachedQueryEmbedder(model, 'm1', cache);
    await embed('room rent');
    const [key] = [...cache.store.keys()];
    for (const bad of ['not base64 !!', '[0.1,0.2]', '{"a":1}', '']) {
      cache.store.set(key, bad);
      expect(await embed('room rent')).toHaveLength(EMBEDDING_DIMENSIONS);
    }
    expect(model.doEmbedCalls).toHaveLength(5);
  });

  it('does not fail the call when set rejects, and does not wait for it', async () => {
    const model = mockEmbeddingModel();
    const rejecting: KeyValueCache = {
      get: async () => null,
      set: async () => {
        throw new Error('redis down');
      },
    };
    expect(await createCachedQueryEmbedder(model, 'm1', rejecting)('room rent')).toHaveLength(
      EMBEDDING_DIMENSIONS,
    );
    const hanging: KeyValueCache = { get: async () => null, set: () => new Promise(() => {}) };
    expect(await createCachedQueryEmbedder(model, 'm1', hanging)('room rent')).toHaveLength(
      EMBEDDING_DIMENSIONS,
    );
    await flush();
  });

  it('returns a model vector of the wrong length or with non-finite values but does not cache it', async () => {
    for (const bad of [[1, 2, 3], Array.from({ length: EMBEDDING_DIMENSIONS }, () => Number.NaN)]) {
      const cache = memoryCache();
      const embed = createCachedQueryEmbedder(
        mockEmbeddingModel(() => bad),
        'm1',
        cache,
      );
      const out = await embed('room rent');
      expect(out).toHaveLength(bad.length);
      await flush();
      expect(cache.store.size).toBe(0);
    }
  });

  it('keys by model id and stores with the ttl', async () => {
    const model = mockEmbeddingModel();
    const ttls: number[] = [];
    const store = new Map<string, string>();
    const cache: KeyValueCache = {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v, ttl) => {
        ttls.push(ttl);
        store.set(k, v);
      },
    };
    await createCachedQueryEmbedder(model, 'a', cache)('q');
    await createCachedQueryEmbedder(model, 'b', cache, { ttlSeconds: 60 })('q');
    expect(store.size).toBe(2);
    expect(ttls).toEqual([7 * 24 * 3600, 60]);
  });

  it('survives a cache whose methods throw synchronously', async () => {
    const model = mockEmbeddingModel();
    const broken = {
      get: () => {
        throw new Error('sync boom');
      },
      set: () => {
        throw new Error('sync boom');
      },
    } as unknown as KeyValueCache;
    expect(await createCachedQueryEmbedder(model, 'm1', broken)('room rent')).toHaveLength(1536);
  });
});
