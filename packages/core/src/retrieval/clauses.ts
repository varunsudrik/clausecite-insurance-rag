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

export function findDefinitions(
  db: Db,
  documentId: string,
  term: string,
  limit = 3,
): Promise<ClauseChunk[]> {
  const pattern = `%${escapeLike(term)}%`;
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
    .orderBy(asc(chunks.chunkIndex))
    .limit(limit);
}
