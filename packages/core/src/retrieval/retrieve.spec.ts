import { describe, expect, it, vi } from 'vitest';
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
});
