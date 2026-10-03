import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunks, documents } from '../db/schema.js';
import { hashEmbedding } from '../testing/mock-models.js';
import { startTestDb, type TestDb } from '../testing/postgres.js';
import { searchChunks } from './search.js';

let t: TestDb;
const ids: Record<string, string> = {};

async function seedDoc(slug: string, clauses: [string, string][]) {
  const [doc] = await t.db
    .insert(documents)
    .values({
      slug,
      title: `${slug} policy`,
      insurer: slug,
      product: `${slug} health`,
      policyType: 'health',
      filePath: `${slug}.pdf`,
      sha256: randomUUID(),
      status: 'ready',
    })
    .returning();
  ids[slug] = doc.id;
  await t.db.insert(chunks).values(
    clauses.map(([clauseId, text], i) => ({
      documentId: doc.id,
      chunkIndex: i,
      clauseId,
      clauseIds: [clauseId],
      sectionPath: ['Section C: Exclusions'],
      pageStart: i + 1,
      pageEnd: i + 1,
      content: text,
      contentForEmbedding: text,
      tokenCount: 10,
      embedding: hashEmbedding(text),
    })),
  );
}

beforeAll(async () => {
  t = await startTestDb();
  await seedDoc('star', [
    ['C.1', 'Cataract surgery is covered after a waiting period of 24 months.'],
    ['C.2', 'PED means pre-existing disease declared in the proposal form.'],
    ['B.2', 'Room rent is limited to one percent of the sum insured per day.'],
  ]);
  await seedDoc('hdfc', [
    ['4.1', 'Cataract treatment has a two year waiting period under this plan.'],
    ['4.2', 'Ambulance charges are covered up to two thousand rupees.'],
  ]);
});
afterAll(async () => {
  await t?.stop();
});

const emb = (q: string) => hashEmbedding(q);

describe('searchChunks', () => {
  it('vector strategy ranks semantically closest chunks first', async () => {
    const q = 'cataract surgery waiting period';
    const res = await searchChunks(t.db, {
      strategy: 'vector',
      queryText: q,
      queryEmbedding: emb(q),
    });
    expect(res[0].clauseId).toBe('C.1');
    expect(res[0]).toMatchObject({ slug: 'star', vectorRank: 1, ftsRank: null, pageStart: 1 });
    expect(typeof res[0].score).toBe('number');
    expect(res[0].clauseIds).toEqual(['C.1']);
  });

  it('fts strategy finds exact jargon like PED', async () => {
    const res = await searchChunks(t.db, { strategy: 'fts', queryText: 'PED' });
    expect(res.map((r) => r.clauseId)).toEqual(['C.2']);
    expect(res[0]).toMatchObject({ ftsRank: 1, vectorRank: null });
  });

  it('hybrid fuses both lists with RRF; chunks in both lists win', async () => {
    const q = 'cataract waiting period';
    const res = await searchChunks(t.db, {
      strategy: 'hybrid',
      queryText: q,
      queryEmbedding: emb(q),
    });
    const top = res[0];
    expect(['C.1', '4.1']).toContain(top.clauseId);
    expect(top.vectorRank).not.toBeNull();
    expect(top.ftsRank).not.toBeNull();
    expect(top.score).toBeCloseTo(1 / (60 + top.vectorRank!) + 1 / (60 + top.ftsRank!), 10);
    for (let i = 1; i < res.length; i++)
      expect(res[i - 1].score).toBeGreaterThanOrEqual(res[i].score);
  });

  it('restricts results to the given documents', async () => {
    const q = 'cataract waiting period';
    const res = await searchChunks(t.db, {
      strategy: 'hybrid',
      queryText: q,
      queryEmbedding: emb(q),
      documentIds: [ids.hdfc],
    });
    expect(res.length).toBeGreaterThan(0);
    expect(new Set(res.map((r) => r.slug))).toEqual(new Set(['hdfc']));
  });

  it('respects the limit', async () => {
    const q = 'covered';
    const res = await searchChunks(t.db, {
      strategy: 'hybrid',
      queryText: q,
      queryEmbedding: emb(q),
      limit: 2,
    });
    expect(res.length).toBeLessThanOrEqual(2);
  });
});
