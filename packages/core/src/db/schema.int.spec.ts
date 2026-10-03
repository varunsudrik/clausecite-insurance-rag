import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDb, type TestDb } from '../testing/postgres.js';
import { chunks, documents, EMBEDDING_DIMENSIONS } from './schema.js';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t?.stop();
});

describe('schema', () => {
  it('stores a chunk with a 1536-d embedding and generates its tsvector', async () => {
    const [doc] = await t.db
      .insert(documents)
      .values({
        slug: 'sample',
        title: 'Sample Policy',
        insurer: 'Acme',
        product: 'Sample Health',
        policyType: 'health',
        filePath: '/tmp/x.pdf',
        sha256: 'abc',
      })
      .returning();
    const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
    await t.db.insert(chunks).values({
      documentId: doc.id,
      chunkIndex: 0,
      clauseId: 'C.2',
      clauseIds: ['C.2'],
      sectionPath: ['Section C: Exclusions'],
      pageStart: 2,
      pageEnd: 2,
      content: 'Cataract has a waiting period of 24 months.',
      contentForEmbedding:
        'Sample Health (Acme) › Exclusions\n\nCataract has a waiting period of 24 months.',
      tokenCount: 20,
      embedding,
    });
    const [row] = await t.db.select().from(chunks).where(eq(chunks.documentId, doc.id));
    expect(row.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(row.tsv).toContain('cataract');
    // 'exclus' only occurs in the content_for_embedding header ("Exclusions"), so this proves
    // the generated column is built from content_for_embedding with the english stemmer.
    expect(row.tsv).toContain('exclus');
  });

  it('creates the hnsw and gin indexes', async () => {
    const res = await t.db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'chunks'`,
    );
    const defs = res.rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
    expect(defs).toMatch(/\bm='?16'?/);
    expect(defs).toMatch(/\bef_construction='?64'?/);
    expect(defs).toMatch(/USING gin \(tsv\)/);
  });

  it('sets hnsw.iterative_scan at connection startup', async () => {
    const client = await t.pool.connect();
    try {
      // Touch the vector type first so the pgvector library is loaded in this session.
      await client.query(`select '[1,2,3]'::vector`);
      const res = await client.query<{ 'hnsw.iterative_scan': string }>('show hnsw.iterative_scan');
      expect(res.rows[0]?.['hnsw.iterative_scan']).toBe('relaxed_order');
    } finally {
      client.release();
    }
  });
});
