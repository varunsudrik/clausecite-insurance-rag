import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema.js';
import { chunks, documents, EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { hashEmbedding } from '../testing/mock-models.js';
import { startTestDb, type TestDb } from '../testing/postgres.js';
import { searchChunks } from './search.js';

let t: TestDb;
const ids: Record<string, string> = {};

async function seedDoc(
  slug: string,
  clauses: [string, string][],
  embed: (text: string, i: number) => number[] = (text) => hashEmbedding(text),
) {
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
      embedding: embed(text, i),
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
    expect(res).toHaveLength(2);
  });

  it('an empty documentIds list matches nothing (it must not fall back to searching everything)', async () => {
    const q = 'cataract waiting period';
    for (const strategy of ['vector', 'fts', 'hybrid'] as const) {
      const res = await searchChunks(t.db, {
        strategy,
        queryText: q,
        queryEmbedding: emb(q),
        documentIds: [],
      });
      expect(res, strategy).toEqual([]);
    }
  });

  it('still validates the embedding before honouring an empty document filter', async () => {
    await expect(
      searchChunks(t.db, { strategy: 'hybrid', queryText: 'x', documentIds: [] }),
    ).rejects.toThrow(/requires queryEmbedding/);
  });
});

describe('searchChunks: lexical and semantic rankings disagree', () => {
  const Q = 'alpha beta';
  const LIMIT = 3;
  const pads = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `pad${from + i}`);

  beforeAll(async () => {
    await seedDoc('dis', [
      // Both words, adjacent, nothing else: top of both lists.
      ['Z', 'alpha beta'],
      // Semantically close (shares "alpha"), but lacks "beta" so the AND query never matches it.
      ['Y0', 'alpha'],
      ['Y1', `alpha ${pads(1, 1).join(' ')}`],
      ['Y2', `alpha ${pads(1, 2).join(' ')}`],
      ['Y3', `alpha ${pads(1, 3).join(' ')}`],
      // Lexical match for both terms, but drowned in unrelated words: semantically far.
      ['X', `alpha ${pads(1, 18).join(' ')} beta ${pads(19, 38).join(' ')}`],
    ]);
  });

  const positionOf = (list: { chunkId: string }[], chunkId: string) => {
    const i = list.findIndex((c) => c.chunkId === chunkId);
    return i === -1 ? null : i + 1;
  };

  it('reports each rank as its position in the single-strategy list, and scores missing ranks as 0', async () => {
    const vecOnly = await searchChunks(t.db, {
      strategy: 'vector',
      queryText: Q,
      queryEmbedding: emb(Q),
      limit: LIMIT,
    });
    const ftsOnly = await searchChunks(t.db, { strategy: 'fts', queryText: Q, limit: LIMIT });
    const hybrid = await searchChunks(t.db, {
      strategy: 'hybrid',
      queryText: Q,
      queryEmbedding: emb(Q),
      limit: LIMIT,
    });

    // Sanity: the fixture really makes the two retrievers disagree.
    expect(vecOnly.map((r) => r.clauseId)).toEqual(['Z', 'Y0', 'Y1']);
    expect(ftsOnly.map((r) => r.clauseId)).toEqual(['Z', 'X']);

    expect(hybrid).toHaveLength(LIMIT);
    for (const row of hybrid) {
      const v = positionOf(vecOnly, row.chunkId);
      const f = positionOf(ftsOnly, row.chunkId);
      expect(row.vectorRank, `${row.clauseId} vectorRank`).toBe(v);
      expect(row.ftsRank, `${row.clauseId} ftsRank`).toBe(f);
      const expected = (v === null ? 0 : 1 / (60 + v)) + (f === null ? 0 : 1 / (60 + f));
      expect(row.score, `${row.clauseId} score`).toBeCloseTo(expected, 12);
    }

    const byClause = Object.fromEntries(hybrid.map((r) => [r.clauseId, r]));
    expect(hybrid[0].clauseId).toBe('Z');
    expect(byClause.Z).toMatchObject({ vectorRank: 1, ftsRank: 1 });
    expect(byClause.Y0).toMatchObject({ vectorRank: 2, ftsRank: null }); // semantic only
    expect(byClause.X).toMatchObject({ vectorRank: null, ftsRank: 2 }); // lexical only
    expect(byClause.Y0.score).toBeCloseTo(1 / 62, 12);
    expect(byClause.X.score).toBeCloseTo(1 / 62, 12);
    for (let i = 1; i < hybrid.length; i++)
      expect(hybrid[i - 1].score).toBeGreaterThanOrEqual(hybrid[i].score);
  });
});

describe('searchChunks: vector rank under a document filter and relaxed HNSW order', () => {
  // 100 chunks in total (well past hnsw.ef_search = 40). Plain random vectors, so the filtered
  // document's rows are interleaved in distance with the other document's rows. That is what makes
  // an HNSW iterative scan emit a filtered row early and a closer one in a later batch.
  const KEEP_ROWS = 40;
  const OTHER_ROWS = 60;

  // Deterministic PRNG (mulberry32) so the fixture is identical on every run.
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const rand = prng(20261003);
  const randomUnit = () => {
    const v = Array.from({ length: EMBEDDING_DIMENSIONS }, () => rand() - 0.5);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const query = randomUnit();
  const keepVecs = Array.from({ length: KEEP_ROWS }, randomUnit);
  const otherVecs = Array.from({ length: OTHER_ROWS }, randomUnit);

  beforeAll(async () => {
    const rows = (prefix: string, n: number): [string, string][] =>
      Array.from({ length: n }, (_, i) => [`${prefix}${i}`, `${prefix} row ${i}`]);
    await seedDoc('keep', rows('K', KEEP_ROWS), (_text, i) => keepVecs[i]);
    await seedDoc('other', rows('O', OTHER_ROWS), (_text, i) => otherVecs[i]);
    await t.pool.query('ANALYZE chunks');
  });

  /**
   * One pinned connection whose planner can only get the vector order from the HNSW index, with a
   * tiny hnsw.ef_search so each iterative-scan batch is small (maximises relaxed-order interleaving).
   * On a ~100 row table the planner would otherwise prefer the document_id btree + an exact sort,
   * which never touches HNSW. The index drops are transactional and rolled back on release, so the
   * shared test database is left untouched. Also logs every executed statement for EXPLAIN.
   */
  async function hnswOnlyDb() {
    const client = await t.pool.connect();
    await client.query('BEGIN');
    await client.query('DROP INDEX chunks_document_id_idx');
    await client.query('DROP INDEX chunks_document_clause_idx');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    await client.query('SET LOCAL hnsw.ef_search = 1');
    const mode = await client.query<{ 'hnsw.iterative_scan': string }>('SHOW hnsw.iterative_scan');
    expect(mode.rows[0]['hnsw.iterative_scan']).toBe('relaxed_order');
    const executed: { query: string; params: unknown[] }[] = [];
    const db = drizzle(client, {
      schema,
      logger: { logQuery: (query, params) => executed.push({ query, params }) },
    });
    const plan = async (i = 0) => {
      const r = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${executed[i].query}`,
        executed[i].params,
      );
      return r.rows.map((row) => row['QUERY PLAN']).join('\n');
    };
    const release = async () => {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release(true);
      }
    };
    return { db, plan, release };
  }

  const vectorSearch = (db: typeof t.db, limit: number) =>
    searchChunks(db, {
      strategy: 'vector',
      queryText: 'ignored',
      queryEmbedding: query,
      documentIds: [ids.keep],
      limit,
    });

  it('ranks the filtered rows by exact distance, not by index emission order', async () => {
    const exact = await t.db.execute<{ id: string }>(sql`
      SELECT id FROM chunks WHERE document_id = ${ids.keep}::uuid
      ORDER BY embedding <=> ${JSON.stringify(query)}::vector, id`);
    const expectedIds = exact.rows.map((r) => r.id);
    expect(expectedIds).toHaveLength(KEEP_ROWS);

    const pinned = await hnswOnlyDb();
    try {
      const res = await vectorSearch(pinned.db, KEEP_ROWS);
      expect(await pinned.plan()).toContain('chunks_embedding_hnsw'); // the index path was exercised
      expect(res.map((r) => r.chunkId)).toEqual(expectedIds);
      expect(res.map((r) => r.vectorRank)).toEqual(expectedIds.map((_, i) => i + 1));
    } finally {
      await pinned.release();
    }
    // Same answer through the default pool connection and planner.
    const viaPool = await vectorSearch(t.db, KEEP_ROWS);
    expect(viaPool.map((r) => r.chunkId)).toEqual(expectedIds);
    expect(viaPool.map((r) => r.vectorRank)).toEqual(expectedIds.map((_, i) => i + 1));
  });

  it('plans a real sort over the (at most LIMIT) index output before numbering ranks', async () => {
    const pinned = await hnswOnlyDb();
    try {
      await vectorSearch(pinned.db, 30);
      const plan = await pinned.plan();
      const lines = plan.split('\n');
      const win = lines.findIndex((l) => l.includes('WindowAgg'));
      expect(win, plan).toBeGreaterThanOrEqual(0);
      // The WindowAgg's direct input is an explicit Sort on dist + 0 (then id) ...
      expect(lines[win + 1], plan).toMatch(/->\s+Sort\b/);
      expect(lines[win + 2], plan).toMatch(/Sort Key: .*dist.*\+.*id/);
      // ... which sits above the LIMIT-bounded HNSW scan that produces the candidates.
      const below = lines.slice(win + 3);
      expect(
        below.some((l) => l.includes('Index Scan using chunks_embedding_hnsw')),
        plan,
      ).toBe(true);
    } finally {
      await pinned.release();
    }
  });
});
