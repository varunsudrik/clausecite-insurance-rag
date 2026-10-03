import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ingestDocument } from '@clausecite/core';
import { mockEmbeddingModel } from '@clausecite/core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHarness, type Harness } from './harness.js';

const PDF = readFileSync(new URL('../../../data/fixtures/sample-policy.pdf', import.meta.url));
const embedding = mockEmbeddingModel();
let h: Harness;
let admin: Record<string, string>;
let guest: Record<string, string>;

beforeAll(async () => {
  h = await startHarness({ models: { embedding } });
  admin = {
    Authorization: `Bearer ${(await h.http.post('/auth/login').send({ email: 'admin@test.local', password: 'admin-pass-123' })).body.token}`,
  };
  guest = { Authorization: `Bearer ${(await h.http.post('/auth/guest')).body.token}` };
  const up = await h.http
    .post('/documents')
    .set(admin)
    .field('slug', 'sample-health')
    .field('title', 'Sample Health Shield')
    .field('insurer', 'Acme')
    .field('product', 'Sample Health Shield')
    .attach('file', PDF, { filename: 'p.pdf', contentType: 'application/pdf' })
    .expect(201);
  await ingestDocument(
    {
      db: h.db,
      embeddingModel: embedding,
      embeddingModelId: 'mock-embedding',
      readFile: async (n) => new Uint8Array(await readFile(join(h.storageDir, n))),
    },
    up.body.id,
  );
});
afterAll(async () => {
  await h?.stop();
});

const search = (body: object, headers = admin) => h.http.post('/search').set(headers).send(body);

describe('POST /search', () => {
  it('returns the cataract clause first with a rerank score (guest allowed)', async () => {
    const res = await search({ query: 'cataract waiting period' }, guest).expect(200);
    expect(res.body.refused).toBe(false);
    expect(res.body.results[0]).toMatchObject({
      slug: 'sample-health',
      clauseIds: ['C.3'],
      pageStart: 3,
    });
    expect(res.body.results[0].rerankScore).toBeGreaterThan(0.5);
  });

  it('supports the fts strategy', async () => {
    const res = await search({ query: 'free look', strategy: 'fts' }).expect(200);
    expect(res.body.results[0].clauseIds).toContain('D.1');
    expect(res.body.results[0].rerankScore).toBeNull();
  });

  it('refuses when nothing is relevant and offers suggestions', async () => {
    const res = await search({ query: 'helicopter evacuation abroad' }).expect(200);
    expect(res.body).toMatchObject({ refused: true, results: [] });
    expect(res.body.suggestions.length).toBeGreaterThan(0);
  });

  it('scopes by slug and 404s unknown documents', async () => {
    await search({ query: 'room rent', documentIds: ['sample-health'] }).expect(200);
    await search({ query: 'room rent', documentIds: ['no-such-doc'] }).expect(404);
  });

  it('validates input', async () => {
    await search({ query: '' }).expect(400);
  });

  it('caches query embeddings', async () => {
    await search({ query: 'ICU charges limit' }).expect(200);
    const before = embedding.doEmbedCalls.length;
    const res = await search({ query: 'icu charges   LIMIT' }).expect(200);
    expect(embedding.doEmbedCalls.length).toBe(before);
    expect(res.body.embeddingCacheHit).toBe(true);
    // stored compactly (base64 float32, not JSON) with the 7 day TTL
    const [key] = await h.redis.keys('emb:mock-embedding:*');
    expect(await h.redis.get(key)).toHaveLength(Math.ceil((1536 * 4) / 3) * 4);
    expect(await h.redis.ttl(key)).toBeGreaterThan(6 * 24 * 3600);
  });

  it('reports a cache miss on the first sighting of a query', async () => {
    const res = await search({ query: 'maternity benefit waiting' }).expect(200);
    expect(res.body.embeddingCacheHit).toBe(false);
  });

  it('requires authentication', async () => {
    await h.http.post('/search').send({ query: 'room rent' }).expect(401);
  });

  it('rejects an invalid strategy or k', async () => {
    await search({ query: 'room rent', strategy: 'magic' }).expect(400);
    await search({ query: 'room rent', k: 0 }).expect(400);
    await search({ query: 'room rent', k: 21 }).expect(400);
  });

  it('honors k', async () => {
    const res = await search({ query: 'cataract waiting period', k: 1 }).expect(200);
    expect(res.body.results).toHaveLength(1);
  });

  it('treats an empty documentIds scope as matching nothing', async () => {
    const res = await search({ query: 'cataract waiting period', documentIds: [] }).expect(200);
    expect(res.body).toMatchObject({ refused: true, results: [] });
  });
});

describe('clauses and definitions', () => {
  it('returns all chunks of a clause', async () => {
    const res = await h.http.get('/documents/sample-health/clauses/C.3').set(guest).expect(200);
    expect(res.body).toMatchObject({ slug: 'sample-health', clauseId: 'C.3', pageStart: 3 });
    expect(res.body.chunks[0].content).toContain('cataract');
    await h.http.get('/documents/sample-health/clauses/Z.9').set(guest).expect(404);
  });

  it('finds definitions by term', async () => {
    const res = await h.http
      .get('/definitions')
      .query({ term: 'hospital', documentId: 'sample-health' })
      .set(guest)
      .expect(200);
    expect(res.body.results[0].content).toContain('Hospital means');
  });

  it('404s clause and definition lookups for unknown documents', async () => {
    await h.http.get('/documents/no-such-doc/clauses/C.3').set(guest).expect(404);
    await h.http
      .get('/definitions')
      .query({ term: 'hospital', documentId: 'no-such-doc' })
      .set(guest)
      .expect(404);
  });

  it('validates the definitions query', async () => {
    await h.http
      .get('/definitions')
      .query({ term: 'h', documentId: 'sample-health' })
      .set(guest)
      .expect(400);
    await h.http.get('/definitions').query({ term: 'hospital' }).set(guest).expect(400);
  });

  it('treats LIKE wildcards in the term literally', async () => {
    const res = await h.http
      .get('/definitions')
      .query({ term: '%%', documentId: 'sample-health' })
      .set(guest)
      .expect(200);
    expect(res.body.results).toEqual([]);
  });

  it('requires authentication', async () => {
    await h.http.get('/documents/sample-health/clauses/C.3').expect(401);
    await h.http
      .get('/definitions')
      .query({ term: 'hospital', documentId: 'sample-health' })
      .expect(401);
  });
});

describe('POST /search rate limit', () => {
  it('limits a guest to 10 searches per minute', async () => {
    // The token is issued on the real clock, then Date is pinned 30 s into the next minute: the 11
    // requests cannot straddle a window boundary, and the token stays valid. Only Date is faked
    // (ioredis and supertest timers stay real), and it is restored even if an assertion fails.
    const fresh = { Authorization: `Bearer ${(await h.http.post('/auth/guest')).body.token}` };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Math.ceil(Date.now() / 60_000) * 60_000 + 30_000);
      for (let i = 0; i < 10; i++) await search({ query: 'room rent' }, fresh).expect(200);
      const res = await search({ query: 'room rent' }, fresh).expect(429);
      expect(res.headers['retry-after']).toBe('30');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POST /search spend protection (DECISIONS 012)', () => {
  const SEARCH_TOKEN_COST = 300;
  const day = () => new Date().toISOString().slice(0, 10);
  const globalKey = () => `budget:global:${day()}`;
  const used = async (key: string) => Number((await h.redis.get(key)) ?? 0);
  const userId = (headers: Record<string, string>) =>
    JSON.parse(Buffer.from(headers.Authorization!.split('.')[1]!, 'base64url').toString())
      .sub as string;
  const userKey = (headers: Record<string, string>) => `budget:${userId(headers)}:${day()}`;

  it('charges SEARCH_TOKEN_COST to the global budget and to a guest, per call', async () => {
    const [globalBefore, guestBefore] = [await used(globalKey()), await used(userKey(guest))];
    await search({ query: 'cataract waiting period' }, guest).expect(200);
    await search({ query: 'room rent' }, guest).expect(200);
    expect(await used(globalKey())).toBe(globalBefore + 2 * SEARCH_TOKEN_COST);
    expect(await used(userKey(guest))).toBe(guestBefore + 2 * SEARCH_TOKEN_COST);
  });

  it('charges an admin to the global budget only', async () => {
    const globalBefore = await used(globalKey());
    await search({ query: 'cataract waiting period' }).expect(200);
    expect(await used(globalKey())).toBe(globalBefore + SEARCH_TOKEN_COST);
    expect(await h.redis.keys(`budget:${userId(admin)}:*`)).toEqual([]);
  });

  it('charges a refused search too, so spamming nonsense is not free', async () => {
    const globalBefore = await used(globalKey());
    const res = await search({ query: 'helicopter evacuation abroad' }, guest).expect(200);
    expect(res.body.refused).toBe(true);
    expect(await used(globalKey())).toBe(globalBefore + SEARCH_TOKEN_COST);
  });

  it('does not charge a request that is rejected before retrieval', async () => {
    const globalBefore = await used(globalKey());
    await search({ query: '' }, guest).expect(400);
    await search({ query: 'room rent', documentIds: ['no-such-doc'] }, guest).expect(404);
    expect(await used(globalKey())).toBe(globalBefore);
  });

  it('answers 429 before any embedding call once the global budget is spent, admins included', async () => {
    const key = globalKey();
    const prior = await h.redis.get(key);
    await h.redis.set(key, '999999999');
    try {
      const embedCalls = embedding.doEmbedCalls.length;
      for (const headers of [guest, admin]) {
        const res = await search({ query: 'a never-seen query for the cap' }, headers).expect(429);
        expect(res.body).toMatchObject({ message: 'Service daily budget exhausted' });
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      }
      expect(embedding.doEmbedCalls.length).toBe(embedCalls);
      expect(await used(key)).toBe(999_999_999); // a blocked call is not charged
    } finally {
      if (prior === null) await h.redis.del(key);
      else await h.redis.set(key, prior);
    }
  });
});
