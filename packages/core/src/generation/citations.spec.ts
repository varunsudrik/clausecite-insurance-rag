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

  it('dedupes numbers within one marker group', () => {
    const r = validateCitations('Both [1, 1] and [2, 1, 2].', SOURCES);
    expect(r.text).toBe('Both [1] and [2][1].');
    expect(r.citations.map((c) => c.n)).toEqual([1, 2]);
  });

  it('removes the single preceding space together with a fully invalid marker', () => {
    expect(validateCitations('Maybe [7].', SOURCES).text).toBe('Maybe.');
    expect(validateCitations('Maybe [7], or not [0, 9]!', SOURCES).text).toBe('Maybe, or not!');
    expect(validateCitations('Edge [9][1].', SOURCES).text).toBe('Edge [1].');
    expect(validateCitations('Edge [9][8].', SOURCES).text).toBe('Edge.');
  });

  describe('cleanup is local to markers and never touches other whitespace', () => {
    it('keeps nested-list indentation exactly, removing only the invalid marker', () => {
      const r = validateCitations('- A [1]:\n  - B\n    - C [9]', SOURCES);
      expect(r.text).toBe('- A [1]:\n  - B\n    - C');
      expect(r.citations.map((c) => c.n)).toEqual([1]);
    });

    it('leaves a fenced code block with 4-space indentation untouched', () => {
      const text = 'Example [2]:\n```\nfn main() {\n    let x  =  1 ;\n\tif x {  }\n}\n```';
      expect(validateCitations(text, SOURCES).text).toBe(text);
    });

    it('leaves a markdown table alignment row untouched', () => {
      const text = '| Plan   | Limit |\n| --- | :---: |\n| A      |  5 lakh [3] |';
      expect(validateCitations(text, SOURCES).text).toBe(text);
    });

    it('does not strip the space before punctuation that is not a removed marker', () => {
      expect(validateCitations('Note : x', SOURCES).text).toBe('Note : x');
      expect(validateCitations('Note : x [1] ; y  z .', SOURCES).text).toBe(
        'Note : x [1] ; y  z .',
      );
    });
  });
});
