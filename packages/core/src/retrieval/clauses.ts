import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { chunks } from '../db/schema.js';

export interface ClauseChunk {
  chunkId: string;
  chunkIndex: number;
  clauseId: string;
  clauseIds: string[];
  sectionPath: string[];
  pageStart: number;
  pageEnd: number;
  content: string;
}

const columns = {
  chunkId: chunks.id,
  chunkIndex: chunks.chunkIndex,
  clauseId: chunks.clauseId,
  clauseIds: chunks.clauseIds,
  sectionPath: chunks.sectionPath,
  pageStart: chunks.pageStart,
  pageEnd: chunks.pageEnd,
  content: chunks.content,
};

export function getClauseChunks(
  db: Db,
  documentId: string,
  clauseId: string,
): Promise<ClauseChunk[]> {
  return db
    .select(columns)
    .from(chunks)
    .where(
      and(
        eq(chunks.documentId, documentId),
        sql`(${chunks.clauseId} = ${clauseId} OR ${clauseId} = ANY(${chunks.clauseIds}))`,
      ),
    )
    .orderBy(asc(chunks.chunkIndex));
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Definitions of `term` within one document. The chunk that actually defines it ("Hospital means ...",
 * also `"Hospital" means` with straight or curly quotes) ranks first; chunks that merely mention the
 * term follow, earliest mention first, then in document order.
 */
export function findDefinitions(
  db: Db,
  documentId: string,
  term: string,
  limit = 3,
): Promise<ClauseChunk[]> {
  const escaped = escapeLike(term);
  const pattern = `%${escaped}%`;
  const defines = [` means`, `" means`, `\u201d means`].map((tail) => `%${escaped}${tail}%`);
  return db
    .select(columns)
    .from(chunks)
    .where(
      and(
        eq(chunks.documentId, documentId),
        sql`EXISTS (SELECT 1 FROM unnest(${chunks.sectionPath}) s WHERE s ILIKE '%definition%')`,
        sql`${chunks.content} ILIKE ${pattern}`,
      ),
    )
    .orderBy(
      sql`(${chunks.content} ILIKE ${defines[0]} OR ${chunks.content} ILIKE ${defines[1]} OR ${chunks.content} ILIKE ${defines[2]}) DESC`,
      sql`position(lower(${term}) in lower(${chunks.content}))`,
      asc(chunks.chunkIndex),
    )
    .limit(limit);
}
