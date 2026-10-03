import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';

export type SearchStrategy = 'vector' | 'fts' | 'hybrid';

export interface SearchParams {
  strategy: SearchStrategy;
  queryText: string;
  queryEmbedding?: number[];
  documentIds?: string[];
  limit?: number;
}

export interface Candidate {
  chunkId: string;
  documentId: string;
  slug: string;
  documentTitle: string;
  insurer: string;
  product: string;
  clauseId: string;
  clauseIds: string[];
  sectionPath: string[];
  pageStart: number;
  pageEnd: number;
  content: string;
  contentForEmbedding: string;
  score: number;
  vectorRank: number | null;
  ftsRank: number | null;
}

export const RRF_K = 60;

interface Row {
  chunk_id: string;
  document_id: string;
  slug: string;
  document_title: string;
  insurer: string;
  product: string;
  clause_id: string;
  clause_ids: string[];
  section_path: string[];
  page_start: number;
  page_end: number;
  content: string;
  content_for_embedding: string;
  vector_rank: number | null;
  fts_rank: number | null;
  score: number;
  [key: string]: unknown;
}

const EMPTY_RANKS = sql`SELECT NULL::uuid AS id, NULL::int AS rnk WHERE FALSE`;

export async function searchChunks(db: Db, p: SearchParams): Promise<Candidate[]> {
  const limit = p.limit ?? 30;
  if (p.strategy !== 'fts' && !p.queryEmbedding) {
    throw new Error(`strategy "${p.strategy}" requires queryEmbedding`);
  }
  // undefined/null = no document filter; an empty list matches nothing (never "search everything").
  if (p.documentIds && p.documentIds.length === 0) return [];
  const filter: SQL = p.documentIds
    ? sql`AND c.document_id IN (${sql.join(
        p.documentIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;

  let vec = EMPTY_RANKS;
  if (p.strategy !== 'fts') {
    const q = JSON.stringify(p.queryEmbedding);
    // The inner ORDER BY ... LIMIT lets the HNSW index supply the nearest candidates (ordering by the
    // select-list alias keeps that pathkey index-friendly and binds the embedding once).
    // With hnsw.iterative_scan = relaxed_order the index may emit rows slightly out of order, and the
    // planner would otherwise trust the subquery's ordering and skip the window sort. `dist + 0` is
    // pgvector's documented remedy: it forces a real Sort of the (at most `limit`) rows, so ranks
    // always follow exact distance. `id` makes ties deterministic.
    vec = sql`
      SELECT id, (row_number() OVER (ORDER BY dist + 0, id))::int AS rnk FROM (
        SELECT c.id, c.embedding <=> ${q}::vector AS dist
        FROM chunks c
        WHERE TRUE ${filter}
        ORDER BY dist
        LIMIT ${limit}
      ) v`;
  }

  let fts = EMPTY_RANKS;
  if (p.strategy !== 'vector') {
    fts = sql`
      SELECT id, (row_number() OVER (ORDER BY rank DESC, id))::int AS rnk FROM (
        SELECT c.id, ts_rank_cd(c.tsv, q) AS rank
        FROM chunks c, websearch_to_tsquery('english', ${p.queryText}) q
        WHERE c.tsv @@ q ${filter}
        ORDER BY rank DESC, c.id
        LIMIT ${limit}
      ) f`;
  }

  const res = await db.execute<Row>(sql`
    WITH vec AS (${vec}), fts AS (${fts}),
    ids AS (SELECT id FROM vec UNION SELECT id FROM fts)
    SELECT c.id AS chunk_id, c.document_id, d.slug, d.title AS document_title, d.insurer, d.product,
           c.clause_id, c.clause_ids, c.section_path, c.page_start, c.page_end,
           c.content, c.content_for_embedding,
           vec.rnk AS vector_rank, fts.rnk AS fts_rank,
           (COALESCE(1.0 / (${RRF_K} + vec.rnk), 0) + COALESCE(1.0 / (${RRF_K} + fts.rnk), 0))::float8 AS score
    FROM ids
    JOIN chunks c ON c.id = ids.id
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN vec ON vec.id = c.id
    LEFT JOIN fts ON fts.id = c.id
    ORDER BY score DESC, c.id
    LIMIT ${limit}`);

  return res.rows.map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    slug: r.slug,
    documentTitle: r.document_title,
    insurer: r.insurer,
    product: r.product,
    clauseId: r.clause_id,
    clauseIds: r.clause_ids,
    sectionPath: r.section_path,
    pageStart: r.page_start,
    pageEnd: r.page_end,
    content: r.content,
    contentForEmbedding: r.content_for_embedding,
    score: Number(r.score),
    vectorRank: r.vector_rank,
    ftsRank: r.fts_rank,
  }));
}
