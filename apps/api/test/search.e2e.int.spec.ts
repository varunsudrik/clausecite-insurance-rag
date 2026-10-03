import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ingestDocument } from '@clausecite/core';
import { mockEmbeddingModel } from '@clausecite/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    const fresh = { Authorization: `Bearer ${(await h.http.post('/auth/guest')).body.token}` };
    for (let i = 0; i < 10; i++) await search({ query: 'room rent' }, fresh).expect(200);
    const res = await search({ query: 'room rent' }, fresh).expect(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
