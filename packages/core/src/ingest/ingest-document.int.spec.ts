import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { asc, eq } from 'drizzle-orm';
import { MockEmbeddingModelV4 } from 'ai/test';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunks, documents, EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { hashEmbedding, mockEmbeddingModel } from '../testing/mock-models.js';
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

/** A PDF whose pages each carry one short word: a text layer exists but is far below the scanned-PDF threshold. */
async function nearlyEmptyPdf(pages = 2): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage().drawText('hello', { x: 50, y: 700 });
  return pdf.save();
}

const deps = () => ({ db: t.db, embeddingModel: mockEmbeddingModel(), embeddingModelId: 'mock-embedding' });
const chunksOf = (id: string) =>
  t.db.select().from(chunks).where(eq(chunks.documentId, id)).orderBy(asc(chunks.chunkIndex));

describe('ingestDocument', () => {
  it('ingests the fixture into ready state with clause-level chunks', async () => {
    const doc = await insertDoc();
    const res = await ingestDocument(deps(), doc.id);
    expect(res.pageCount).toBe(4);
    expect(res.embeddingTokens).toBeGreaterThan(0);
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

  it('serializes overlapping ingests of the same document (no duplicate chunks)', async () => {
    const doc = await insertDoc();
    // Hold both ingests at the embedding step until both arrive, so they hit the transaction together.
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const gated = new MockEmbeddingModelV4({
      modelId: 'gated-embedding',
      maxEmbeddingsPerCall: 100,
      doEmbed: async ({ values }) => {
        if (++arrived === 2) open();
        await gate;
        return {
          embeddings: values.map((v) => hashEmbedding(String(v))),
          usage: { tokens: values.length },
          warnings: [],
        };
      },
    });
    const run = () => ingestDocument({ ...deps(), embeddingModel: gated }, doc.id);
    const [first] = await Promise.all([run(), run()]);
    expect(await chunksOf(doc.id)).toHaveLength(first.chunkCount);
  });

  it('reports DOCUMENT_NOT_FOUND (not an FK error) when the document is deleted mid-ingest', async () => {
    const doc = await insertDoc();
    let reached!: () => void;
    const atEmbedding = new Promise<void>((resolve) => (reached = resolve));
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => (proceed = resolve));
    const gated = new MockEmbeddingModelV4({
      modelId: 'gated-embedding',
      maxEmbeddingsPerCall: 100,
      doEmbed: async ({ values }) => {
        reached();
        await gate;
        return {
          embeddings: values.map((v) => hashEmbedding(String(v))),
          usage: { tokens: values.length },
          warnings: [],
        };
      },
    });
    const pending = ingestDocument({ ...deps(), embeddingModel: gated }, doc.id).catch((e) => e);
    await atEmbedding;
    await t.db.delete(documents).where(eq(documents.id, doc.id));
    proceed();
    expect(await pending).toMatchObject({ code: 'DOCUMENT_NOT_FOUND', retryable: false });
  });

  it('rejects an unknown document id with DOCUMENT_NOT_FOUND', async () => {
    await expect(ingestDocument(deps(), randomUUID())).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
      retryable: false,
    });
  });

  it('classifies an unreadable file as non-retryable FILE_NOT_FOUND', async () => {
    const missing = await insertDoc('/nope/missing.pdf');
    const err = await ingestDocument(deps(), missing.id).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err).toMatchObject({ code: 'FILE_NOT_FOUND', retryable: false });
  });

  it('classifies a provider outage as retryable EMBEDDING_FAILED and leaves existing chunks untouched', async () => {
    const doc = await insertDoc();
    const ok = await ingestDocument(deps(), doc.id);
    const before = (await chunksOf(doc.id)).map((r) => r.id);
    const broken = mockEmbeddingModel(() => {
      throw new Error('provider down');
    });
    const err = await ingestDocument(
      { ...deps(), embeddingModel: broken, embeddingMaxRetries: 0 },
      doc.id,
    ).catch((e) => e);
    expect(err).toMatchObject({ code: 'EMBEDDING_FAILED', retryable: true });
    const after = await chunksOf(doc.id);
    expect(after).toHaveLength(ok.chunkCount);
    expect(after.map((r) => r.id)).toEqual(before);
  });

  it('rejects wrong-dimension embeddings as non-retryable EMBEDDING_INVALID and leaves chunks untouched', async () => {
    const doc = await insertDoc();
    const ok = await ingestDocument(deps(), doc.id);
    const before = (await chunksOf(doc.id)).map((r) => r.id);
    const err = await ingestDocument(
      { ...deps(), embeddingModel: mockEmbeddingModel(() => [1, 2, 3]) },
      doc.id,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err).toMatchObject({ code: 'EMBEDDING_INVALID', retryable: false });
    expect(err.message).toContain(String(EMBEDDING_DIMENSIONS));
    const after = await chunksOf(doc.id);
    expect(after).toHaveLength(ok.chunkCount);
    expect(after.map((r) => r.id)).toEqual(before);
  });

  it('never writes chunks when the provider returns fewer vectors than chunks', async () => {
    const doc = await insertDoc();
    const short = new MockEmbeddingModelV4({
      modelId: 'short-embedding',
      maxEmbeddingsPerCall: 100,
      doEmbed: async ({ values }) => ({
        embeddings: values.slice(1).map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1)),
        usage: { tokens: values.length },
        warnings: [],
      }),
    });
    const err = await ingestDocument({ ...deps(), embeddingModel: short }, doc.id).catch((e) => e);
    // embedMany rejects the count mismatch itself (EMBEDDING_FAILED); the service's own check is defence in depth.
    expect(err).toBeInstanceOf(IngestError);
    expect(['EMBEDDING_FAILED', 'EMBEDDING_INVALID']).toContain(err.code);
    expect(await chunksOf(doc.id)).toHaveLength(0);
  });

  it('rolls back the chunk delete when the insert fails mid-transaction', async () => {
    const doc = await insertDoc();
    const ok = await ingestDocument(deps(), doc.id);
    const before = (await chunksOf(doc.id)).map((r) => r.id);
    // Correct length passes validation; pgvector rejects NaN at INSERT, after the DELETE already ran.
    const nan = mockEmbeddingModel(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => Number.NaN));
    await expect(ingestDocument({ ...deps(), embeddingModel: nan }, doc.id)).rejects.toThrow();
    const after = await chunksOf(doc.id);
    expect(after).toHaveLength(ok.chunkCount);
    expect(after.map((r) => r.id).sort()).toEqual([...before].sort());
    const [row] = await t.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.chunkCount).toBe(ok.chunkCount);
  });

  it('rejects documents over maxPages with non-retryable TOO_MANY_PAGES', async () => {
    const doc = await insertDoc();
    const err = await ingestDocument({ ...deps(), maxPages: 2 }, doc.id).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err).toMatchObject({ code: 'TOO_MANY_PAGES', retryable: false });
    expect(await chunksOf(doc.id)).toHaveLength(0);
  });

  it('rejects a PDF without a usable text layer with non-retryable NO_TEXT_LAYER', async () => {
    const doc = await insertDoc('scanned.pdf');
    const readFile = async () => nearlyEmptyPdf();
    const err = await ingestDocument({ ...deps(), readFile }, doc.id).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err).toMatchObject({ code: 'NO_TEXT_LAYER', retryable: false });
    expect(await chunksOf(doc.id)).toHaveLength(0);
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
