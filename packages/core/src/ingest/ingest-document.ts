import { readFile } from 'node:fs/promises';
import type { EmbeddingModel } from 'ai';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { chunks, documents, EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { embedTexts } from '../llm/embed.js';
import { chunkClauses } from './chunker.js';
import { IngestError } from './errors.js';
import { assertTextLayer, extractPageLines, removeRepeatedHeaderFooter } from './pdf-lines.js';
import { buildSectionTree, flattenClauses } from './structure.js';

export interface IngestDeps {
  db: Db;
  embeddingModel: EmbeddingModel;
  embeddingModelId: string;
  readFile?: (filePath: string) => Promise<Uint8Array>;
  maxPages?: number;
  embeddingMaxRetries?: number;
}

export interface IngestResult {
  pageCount: number;
  chunkCount: number;
  embeddingTokens: number;
}

const defaultRead = async (p: string) => new Uint8Array(await readFile(p));

export async function ingestDocument(deps: IngestDeps, documentId: string): Promise<IngestResult> {
  const { db } = deps;
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) throw new IngestError('DOCUMENT_NOT_FOUND', `document ${documentId} not found`);
  await db.update(documents).set({ status: 'processing' }).where(eq(documents.id, documentId));

  let data: Uint8Array;
  try {
    data = await (deps.readFile ?? defaultRead)(doc.filePath);
  } catch (err) {
    throw new IngestError('FILE_NOT_FOUND', `cannot read ${doc.filePath}`, { cause: err });
  }

  const pages = removeRepeatedHeaderFooter(
    await extractPageLines(data, { maxPages: deps.maxPages ?? 200 }),
  );
  assertTextLayer(pages);
  const drafts = chunkClauses(flattenClauses(buildSectionTree(pages)), {
    product: doc.product,
    insurer: doc.insurer,
  });

  let embedded: { embeddings: number[][]; tokens: number };
  try {
    embedded = await embedTexts(
      deps.embeddingModel,
      drafts.map((d) => d.contentForEmbedding),
      { maxRetries: deps.embeddingMaxRetries ?? 3 },
    );
  } catch (err) {
    throw new IngestError('EMBEDDING_FAILED', `embedding failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  assertValidEmbeddings(embedded.embeddings, drafts.length);

  await db.transaction(async (tx) => {
    // Serialize overlapping ingests of the same document: without the row lock, two transactions can
    // both delete (seeing no chunks) and then both insert, leaving duplicate chunks.
    const locked = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, documentId))
      .for('update');
    if (locked.length === 0)
      throw new IngestError('DOCUMENT_NOT_FOUND', `document ${documentId} not found`);
    await tx.delete(chunks).where(eq(chunks.documentId, documentId));
    if (drafts.length > 0) {
      await tx
        .insert(chunks)
        .values(drafts.map((d, i) => ({ ...d, documentId, embedding: embedded.embeddings[i] })));
    }
    await tx
      .update(documents)
      .set({
        status: 'ready',
        error: null,
        pageCount: pages.length,
        chunkCount: drafts.length,
        embeddingModel: deps.embeddingModelId,
      })
      .where(eq(documents.id, documentId));
  });

  return { pageCount: pages.length, chunkCount: drafts.length, embeddingTokens: embedded.tokens };
}

/** A wrong-dimension EMBEDDING_MODEL is a misconfiguration: fail fast and non-retryably, before touching chunks. */
function assertValidEmbeddings(embeddings: number[][], expectedCount: number): void {
  if (embeddings.length !== expectedCount) {
    throw new IngestError(
      'EMBEDDING_INVALID',
      `expected ${expectedCount} embeddings, got ${embeddings.length}`,
    );
  }
  const badIndex = embeddings.findIndex((e) => e.length !== EMBEDDING_DIMENSIONS);
  if (badIndex !== -1) {
    throw new IngestError(
      'EMBEDDING_INVALID',
      `expected ${EMBEDDING_DIMENSIONS}-dimension embeddings, got ${embeddings[badIndex].length} for chunk ${badIndex}`,
    );
  }
}

export function describeError(err: unknown): string {
  const text =
    err instanceof IngestError
      ? `${err.code}: ${err.message}`
      : `UNKNOWN: ${(err as Error)?.message ?? String(err)}`;
  return text.slice(0, 2000);
}

export async function markIngestRetrying(
  db: Db,
  documentId: string,
  err: unknown,
  attempts: number,
) {
  await db
    .update(documents)
    .set({ status: 'queued', error: describeError(err), attempts })
    .where(eq(documents.id, documentId));
}

export async function markIngestFailed(db: Db, documentId: string, err: unknown, attempts: number) {
  await db
    .update(documents)
    .set({ status: 'failed', error: describeError(err), attempts })
    .where(eq(documents.id, documentId));
}
