import type { Reranker } from '../llm/rerank.js';
import type { Candidate, SearchParams, SearchStrategy } from './search.js';

export type RetrievalStrategy = SearchStrategy | 'hybrid_rerank';

export interface RankedChunk extends Candidate {
  rerankScore: number | null;
}

export interface RetrieveDeps {
  search(p: SearchParams): Promise<Candidate[]>;
  embedQuery(q: string): Promise<number[]>;
  reranker: Reranker;
  onRerankDegraded?(err: unknown): void;
}

export interface RetrieveOptions {
  query: string;
  documentIds?: string[];
  strategy?: RetrievalStrategy;
  topK?: number;
  candidates?: number;
  threshold: number;
}

export interface RetrieveResult {
  chunks: RankedChunk[];
  suggestions: RankedChunk[];
  refused: boolean;
  rerankDegraded: boolean;
  timings: { embedMs: number; searchMs: number; rerankMs: number };
}

const ranked = (c: Candidate, rerankScore: number | null = null): RankedChunk => ({
  ...c,
  rerankScore,
});

export async function retrieve(deps: RetrieveDeps, opts: RetrieveOptions): Promise<RetrieveResult> {
  const strategy = opts.strategy ?? 'hybrid_rerank';
  const topK = opts.topK ?? 6;
  const timings = { embedMs: 0, searchMs: 0, rerankMs: 0 };

  let t = performance.now();
  const queryEmbedding = strategy === 'fts' ? undefined : await deps.embedQuery(opts.query);
  timings.embedMs = performance.now() - t;

  t = performance.now();
  const candidates = await deps.search({
    strategy: strategy === 'hybrid_rerank' ? 'hybrid' : strategy,
    queryText: opts.query,
    queryEmbedding,
    documentIds: opts.documentIds,
    limit: opts.candidates ?? 30,
  });
  timings.searchMs = performance.now() - t;

  const base = { suggestions: [] as RankedChunk[], rerankDegraded: false, timings };
  if (candidates.length === 0) return { ...base, chunks: [], refused: true };
  if (strategy !== 'hybrid_rerank') {
    return { ...base, chunks: candidates.slice(0, topK).map((c) => ranked(c)), refused: false };
  }

  t = performance.now();
  try {
    const hits = await deps.reranker.rerank(
      opts.query,
      candidates.map((c) => c.contentForEmbedding),
      candidates.length,
    );
    timings.rerankMs = performance.now() - t;
    // Don't rely on the Reranker implementation's ordering: the gate and the suggestions need best-first.
    const reranked = hits
      .filter((h) => candidates[h.index] !== undefined)
      .sort((a, b) => b.score - a.score)
      .map((h) => ranked(candidates[h.index], h.score));
    const kept = reranked.filter((c) => (c.rerankScore ?? 0) >= opts.threshold).slice(0, topK);
    return {
      ...base,
      chunks: kept,
      suggestions: kept.length === 0 ? reranked.slice(0, 3) : [],
      refused: kept.length === 0,
    };
  } catch (err) {
    timings.rerankMs = performance.now() - t;
    deps.onRerankDegraded?.(err);
    return {
      ...base,
      chunks: candidates.slice(0, topK).map((c) => ranked(c)),
      refused: false,
      rerankDegraded: true,
    };
  }
}
