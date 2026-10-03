import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunks, documents } from '../db/schema.js';
import { mockEmbeddingModel } from '../testing/mock-models.js';
import { startTestDb, type TestDb } from '../testing/postgres.js';
import { IngestError } from './errors.js';
import { ingestDocument, markIngestFailed, markIngestRetrying } from './ingest-document.js';

const FIXTURE = fileURLToPath(new URL('../../../../data/fixtures/sample-policy.pdf', import.meta.url));
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t?.stop();
});

async function insertDoc(filePath = FIXTURE) {
  const [doc] = await t.db
    .insert(documents)
    .values({
      slug: `doc-${randomUUID()}`,
      title: 'Sample Health Shield',
      insurer: 'Acme',
      product: 'Sample Health Shield',
      policyType: 'health',
      filePath,
      sha256: randomUUID(),
    })
    .returning();
  return doc;
}

const deps = () => ({ db: t.db, embeddingModel: mockEmbeddingModel(), embeddingModelId: 'mock-embedding' });
const chunksOf = (id: string) =>
  t.db.select().from(chunks).where(eq(chunks.documentId, id)).orderBy(asc(chunks.chunkIndex));

describe('ingestDocument', () => {
  it('ingests the fixture into ready state with clause-level chunks', async () => {
    const doc = await insertDoc();
    const res = await ingestDocument(deps(), doc.id);
    expect(res.pageCount).toBe(4);
    const rows = await chunksOf(doc.id);
    expect(rows).toHaveLength(res.chunkCount);
    expect(rows.flatMap((r) => r.clauseIds)).toEqual([
      'A.1', 'A.2', 'B.1', 'B.2', 'B.3', 'C.1', 'C.2', 'C.2.1', 'C.3', 'D.1', 'D.2',
    ]);
    expect(rows.find((r) => r.clauseIds.includes('C.3'))!.pageStart).toBe(3);
    expect(rows[0].contentForEmbedding.startsWith('Sample Health Shield (Acme) › ')).toBe(true);
    const [after] = await t.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after).toMatchObject({
      status: 'ready',
      error: null,
      pageCount: 4,
      chunkCount: rows.length,
      embeddingModel: 'mock-embedding',
    });
  });

  it('is idempotent: re-ingesting replaces chunks instead of duplicating', async () => {
    const doc = await insertDoc();
    const first = await ingestDocument(deps(), doc.id);
    await ingestDocument(deps(), doc.id);
    expect(await chunksOf(doc.id)).toHaveLength(first.chunkCount);
  });

  it('classifies failures and leaves existing chunks untouched', async () => {
    await expect(ingestDocument(deps(), randomUUID())).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });

    const missing = await insertDoc('/nope/missing.pdf');
    const err = await ingestDocument(deps(), missing.id).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err).toMatchObject({ code: 'FILE_NOT_FOUND', retryable: false });

    const doc = await insertDoc();
    const ok = await ingestDocument(deps(), doc.id);
    const broken = mockEmbeddingModel(() => {
      throw new Error('provider down');
    });
    const embErr = await ingestDocument(
      { ...deps(), embeddingModel: broken, embeddingMaxRetries: 0 },
      doc.id,
    ).catch((e) => e);
    expect(embErr).toMatchObject({ code: 'EMBEDDING_FAILED', retryable: true });
    expect(await chunksOf(doc.id)).toHaveLength(ok.chunkCount);
  });

  it('records retrying and failed states with the error code', async () => {
    const doc = await insertDoc();
    await markIngestRetrying(t.db, doc.id, new IngestError('EMBEDDING_FAILED', 'timeout'), 1);
    let [row] = await t.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row).toMatchObject({ status: 'queued', attempts: 1, error: 'EMBEDDING_FAILED: timeout' });
    await markIngestFailed(t.db, doc.id, new Error('db gone'), 3);
    [row] = await t.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row).toMatchObject({ status: 'failed', attempts: 3, error: 'UNKNOWN: db gone' });
  });
});
