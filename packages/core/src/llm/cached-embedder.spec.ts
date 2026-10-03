import { describe, expect, it } from 'vitest';
import { mockEmbeddingModel } from '../testing/mock-models.js';
import { createCachedQueryEmbedder, type KeyValueCache } from './cached-embedder.js';

const memoryCache = (): KeyValueCache & { store: Map<string, string> } => {
  const store = new Map<string, string>();
  return { store, get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v) };
};

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

  it('treats a corrupt or malformed cache entry as a miss and overwrites it', async () => {
    const model = mockEmbeddingModel();
    const cache = memoryCache();
    let misses = 0;
    const embed = createCachedQueryEmbedder(model, 'm1', cache, { onMiss: () => misses++ });
    await embed('room rent');
    const [key] = [...cache.store.keys()];
    for (const bad of ['not json', '{"a":1}', '[]', '["x"]']) {
      cache.store.set(key, bad);
      expect(await embed('room rent')).toHaveLength(1536);
      expect(JSON.parse(cache.store.get(key) ?? 'null')).toHaveLength(1536);
    }
    expect(misses).toBe(5);
    expect(model.doEmbedCalls).toHaveLength(5);
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
