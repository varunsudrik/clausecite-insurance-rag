import { describe, expect, it, vi } from 'vitest';
import type { Reranker } from '../llm/rerank.js';
import { fakeReranker, failingReranker } from '../testing/mock-models.js';
import { retrieve } from './retrieve.js';
import type { Candidate } from './search.js';

const cand = (id: string, content: string): Candidate => ({
  chunkId: id,
  documentId: 'd1',
  slug: 'star',
  documentTitle: 'Star',
  insurer: 'Star',
  product: 'Star',
  clauseId: id,
  clauseIds: [id],
  sectionPath: [],
  pageStart: 1,
  pageEnd: 1,
  content,
  contentForEmbedding: content,
  score: 0.01,
  vectorRank: 1,
  ftsRank: null,
});
const CANDS = [
  cand('a', 'ambulance'),
  cand('b', 'cataract waiting'),
  cand('c', 'cataract surgery'),
  cand('d', 'room rent'),
];
const deps = (over: Partial<Parameters<typeof retrieve>[0]> = {}) => ({
  search: vi.fn(async () => CANDS),
  embedQuery: vi.fn(async () => [1, 0]),
  reranker: fakeReranker((_q, d) =>
    d.includes('cataract') ? (d.includes('waiting') ? 0.9 : 0.5) : 0.05,
  ),
  ...over,
});

describe('retrieve', () => {
  it('reranks, applies the threshold and keeps top K in rerank order', async () => {
    const r = await retrieve(deps(), { query: 'cataract waiting period', threshold: 0.2, topK: 6 });
    expect(r.refused).toBe(false);
    expect(r.chunks.map((c) => [c.chunkId, c.rerankScore])).toEqual([
      ['b', 0.9],
      ['c', 0.5],
    ]);
  });

  it('refuses when nothing passes the threshold and returns 3 suggestions', async () => {
    const r = await retrieve(deps({ reranker: fakeReranker(() => 0.01) }), {
      query: 'x',
      threshold: 0.2,
    });
    expect(r.refused).toBe(true);
    expect(r.chunks).toEqual([]);
    expect(r.suggestions).toHaveLength(3);
  });

  it('refuses on zero candidates', async () => {
    const r = await retrieve(deps({ search: vi.fn(async () => []) }), {
      query: 'x',
      threshold: 0.2,
    });
    expect(r).toMatchObject({ refused: true, chunks: [], suggestions: [] });
  });

  it('falls back to RRF order when the reranker fails', async () => {
    const onRerankDegraded = vi.fn();
    const r = await retrieve(deps({ reranker: failingReranker(), onRerankDegraded }), {
      query: 'x',
      threshold: 0.2,
      topK: 2,
    });
    expect(r).toMatchObject({ refused: false, rerankDegraded: true });
    expect(r.chunks.map((c) => c.chunkId)).toEqual(['a', 'b']);
    expect(onRerankDegraded).toHaveBeenCalledOnce();
  });

  it('skips rerank for plain strategies and skips embedding for fts', async () => {
    const d = deps();
    const r = await retrieve(d, { query: 'x', threshold: 0.2, strategy: 'fts', topK: 3 });
    expect(r.chunks).toHaveLength(3);
    expect(r.chunks[0].rerankScore).toBeNull();
    expect(d.embedQuery).not.toHaveBeenCalled();
    expect(d.search).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'fts', queryEmbedding: undefined }),
    );
  });

  describe('gate and ordering details', () => {
    // CANDS arrive in RRF order a, b, c, d (contents: ambulance, cataract waiting, cataract surgery, room rent).
    const byContent = (scores: Record<string, number>) =>
      fakeReranker((_q, doc) => scores[doc] ?? Number.NaN);

    it('orders by rerank score, not by the incoming RRF order', async () => {
      const reranker = byContent({
        ambulance: 0.1,
        'cataract waiting': 0.5,
        'cataract surgery': 0.95,
        'room rent': 0.3,
      });
      const r = await retrieve(deps({ reranker }), { query: 'x', threshold: 0.2 });
      expect(r.refused).toBe(false);
      expect(r.chunks.map((c) => [c.chunkId, c.rerankScore])).toEqual([
        ['c', 0.95],
        ['b', 0.5],
        ['d', 0.3],
      ]);
      expect(r.suggestions).toEqual([]);
    });

    it('caps the passing candidates at topK, keeping the best by rerank score', async () => {
      const reranker = byContent({
        ambulance: 0.8,
        'cataract waiting': 0.6,
        'cataract surgery': 0.9,
        'room rent': 0.7,
      });
      const r = await retrieve(deps({ reranker }), { query: 'x', threshold: 0.2, topK: 2 });
      expect(r.refused).toBe(false);
      expect(r.chunks.map((c) => c.chunkId)).toEqual(['c', 'a']);
      expect(r.suggestions).toEqual([]);
    });

    it('keeps a candidate whose score equals the threshold and drops one just below it', async () => {
      const reranker = byContent({
        ambulance: 0.2,
        'cataract waiting': 0.1999,
        'cataract surgery': 0.5,
        'room rent': 0,
      });
      const r = await retrieve(deps({ reranker }), { query: 'x', threshold: 0.2 });
      expect(r.chunks.map((c) => [c.chunkId, c.rerankScore])).toEqual([
        ['c', 0.5],
        ['a', 0.2],
      ]);
    });

    it('does not rely on the reranker returning hits sorted, and ignores unknown indexes', async () => {
      const unsorted: Reranker = {
        rerank: vi.fn(async () => [
          { index: 0, score: 0.3 },
          { index: 99, score: 1 },
          { index: 1, score: 0.9 },
          { index: 2, score: 0.6 },
        ]),
      };
      const r = await retrieve(deps({ reranker: unsorted }), { query: 'x', threshold: 0.2 });
      expect(r.chunks.map((c) => [c.chunkId, c.rerankScore])).toEqual([
        ['b', 0.9],
        ['c', 0.6],
        ['a', 0.3],
      ]);
    });

    it('orders refusal suggestions by rerank score too', async () => {
      const unsorted: Reranker = {
        rerank: vi.fn(async () => [
          { index: 0, score: 0.05 },
          { index: 1, score: 0.15 },
          { index: 2, score: 0.1 },
          { index: 3, score: 0.12 },
        ]),
      };
      const r = await retrieve(deps({ reranker: unsorted }), { query: 'x', threshold: 0.2 });
      expect(r.refused).toBe(true);
      expect(r.chunks).toEqual([]);
      expect(r.suggestions.map((c) => [c.chunkId, c.rerankScore])).toEqual([
        ['b', 0.15],
        ['d', 0.12],
        ['c', 0.1],
      ]);
    });

    it('reranks every candidate (embedded text, RRF order) for the original query', async () => {
      const rerank = vi.fn(async (_q: string, docs: string[]) =>
        docs.map((_d, index) => ({ index, score: 0.9 - index * 0.1 })),
      );
      await retrieve(deps({ reranker: { rerank } }), { query: 'the query', threshold: 0.2 });
      expect(rerank).toHaveBeenCalledExactlyOnceWith(
        'the query',
        ['ambulance', 'cataract waiting', 'cataract surgery', 'room rent'],
        4,
      );
    });
  });

  describe('what retrieve asks search for', () => {
    it('passes documentIds, the candidate limit, the query and the embedding; hybrid_rerank searches hybrid', async () => {
      const d = deps();
      await retrieve(d, {
        query: 'q',
        documentIds: ['doc-1', 'doc-2'],
        candidates: 12,
        threshold: 0.2,
      });
      expect(d.embedQuery).toHaveBeenCalledExactlyOnceWith('q');
      expect(d.search).toHaveBeenCalledExactlyOnceWith({
        strategy: 'hybrid',
        queryText: 'q',
        queryEmbedding: [1, 0],
        documentIds: ['doc-1', 'doc-2'],
        limit: 12,
      });
    });

    it('defaults to 30 candidates and no document filter', async () => {
      const d = deps();
      await retrieve(d, { query: 'q', threshold: 0.2 });
      expect(d.search).toHaveBeenCalledExactlyOnceWith({
        strategy: 'hybrid',
        queryText: 'q',
        queryEmbedding: [1, 0],
        documentIds: undefined,
        limit: 30,
      });
    });

    it.each(['vector', 'hybrid'] as const)(
      'strategy %s embeds, searches as-is and never reranks',
      async (strategy) => {
        const rerank = vi.fn();
        const d = deps({ reranker: { rerank } });
        const r = await retrieve(d, { query: 'q', threshold: 0.99, strategy, topK: 2 });
        expect(d.search).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ strategy, queryEmbedding: [1, 0] }),
        );
        expect(rerank).not.toHaveBeenCalled();
        expect(r.refused).toBe(false);
        expect(r.chunks.map((c) => [c.chunkId, c.rerankScore])).toEqual([
          ['a', null],
          ['b', null],
        ]);
      },
    );

    it('hands an empty documentIds list to search unchanged (never coerced into "no filter") and refuses on no candidates', async () => {
      const d = deps({ search: vi.fn(async () => []) });
      const r = await retrieve(d, { query: 'q', documentIds: [], threshold: 0.2 });
      expect(d.search).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ documentIds: [] }),
      );
      expect(r).toMatchObject({ refused: true, chunks: [], suggestions: [] });
    });
  });
});
