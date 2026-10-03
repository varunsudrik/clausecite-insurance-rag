import { describe, expect, it } from 'vitest';
import { validateCitations, type CitableSource } from './citations.js';

const src = (id: string): CitableSource => ({
  chunkId: id,
  documentId: 'd',
  clauseId: id.toUpperCase(),
  pageStart: 1,
  pageEnd: 2,
});
const SOURCES = [src('a'), src('b'), src('c')];

describe('validateCitations', () => {
  it('keeps valid markers and lists citations in order of first use', () => {
    const r = validateCitations('Covered after 24 months [2]. Room rent capped [1][2].', SOURCES);
    expect(r.text).toBe('Covered after 24 months [2]. Room rent capped [1][2].');
    expect(r.citations.map((c) => c.n)).toEqual([2, 1]);
    expect(r.citations[0]).toEqual({
      n: 2,
      chunkId: 'b',
      documentId: 'd',
      clauseId: 'B',
      pageStart: 1,
      pageEnd: 2,
    });
    expect(r.invalidMarkers).toEqual([]);
  });

  it('normalises comma lists and strips out-of-range markers', () => {
    const r = validateCitations('Excluded [1, 3]. Also maybe [7]. And [0, 2].', SOURCES);
    expect(r.text).toBe('Excluded [1][3]. Also maybe. And [2].');
    expect(r.citations.map((c) => c.n)).toEqual([1, 3, 2]);
    expect(r.invalidMarkers.sort()).toEqual([0, 7]);
  });

  it('returns no citations for uncited text', () => {
    expect(validateCitations('No sources here.', SOURCES).citations).toEqual([]);
  });
});
