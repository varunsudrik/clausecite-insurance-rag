import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkClauses, splitText } from './chunker.js';
import { extractPageLines, removeRepeatedHeaderFooter } from './pdf-lines.js';
import { buildSectionTree, flattenClauses, type Clause } from './structure.js';
import { countTokens } from './tokens.js';

const meta = { product: 'Sample Health Shield', insurer: 'Acme' };
const clause = (id: string, text: string, path = ['Section C: Exclusions'], page = 1): Clause => ({
  clauseId: id,
  title: `${id} Title`,
  sectionPath: path,
  pageStart: page,
  pageEnd: page,
  text,
});
const sentence = (i: number) => `Sentence number ${i} explains a specific rule about hospital cover and limits.`;

describe('countTokens', () => {
  it('counts cl100k tokens', () => {
    expect(countTokens('hello world')).toBe(2);
  });

  it('treats special-token literals as plain text instead of throwing', () => {
    expect(() => countTokens('see <|endoftext|> here')).not.toThrow();
    expect(countTokens('see <|endoftext|> here')).toBeGreaterThan(0);
  });
});

describe('splitText', () => {
  it('splits under the limit with sentence overlap', () => {
    const text = Array.from({ length: 120 }, (_, i) => sentence(i)).join(' ');
    const parts = splitText(text, 200, 40);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) expect(countTokens(p)).toBeLessThanOrEqual(200);
    const lastOfFirst = parts[0].split(/(?<=\.)\s+/).at(-1)!;
    const firstOfSecond = parts[1].split(/(?<=\.)\s+/)[0];
    expect(parts[1]).toContain(lastOfFirst); // overlap carried forward
    expect(parts[0]).toContain(firstOfSecond);
  });

  it('hard-splits a single oversized sentence on words', () => {
    const parts = splitText('word '.repeat(1000).trim(), 100, 10);
    for (const p of parts) expect(countTokens(p)).toBeLessThanOrEqual(100);
    expect(parts.join(' ').split(' ')).toHaveLength(1000);
  });
});

describe('chunkClauses', () => {
  it('builds one chunk per normal clause with a contextual header', () => {
    const big = clause('C.2', Array.from({ length: 12 }, (_, i) => sentence(i)).join(' '), ['Section C: Exclusions'], 3);
    const [c] = chunkClauses([big], meta);
    expect(c).toMatchObject({ chunkIndex: 0, clauseId: 'C.2', clauseIds: ['C.2'], pageStart: 3, pageEnd: 3 });
    expect(c.content.startsWith('C.2 Title\n')).toBe(true);
    expect(c.contentForEmbedding.split('\n')[0]).toBe('Sample Health Shield (Acme) › Section C: Exclusions › C.2 Title');
    expect(c.tokenCount).toBe(countTokens(c.contentForEmbedding));
  });

  it('splits long clauses, keeping clause id and title on every piece', () => {
    const long = clause('B.2', Array.from({ length: 150 }, (_, i) => sentence(i)).join(' '));
    const out = chunkClauses([long], meta);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.clauseId).toBe('B.2');
      expect(c.content.startsWith('B.2 Title\n')).toBe(true);
      expect(countTokens(c.content)).toBeLessThanOrEqual(600);
    }
    expect(out.map((c) => c.chunkIndex)).toEqual(out.map((_, i) => i));
  });

  it('merges small siblings but not across sections or into big clauses', () => {
    const big = clause('C.1', Array.from({ length: 12 }, (_, i) => sentence(i)).join(' '));
    const out = chunkClauses(
      [
        big,
        clause('C.2', 'Short rule.', undefined, 2),
        clause('C.3', 'Another short rule.', undefined, 3),
        clause('D.1', 'Different section.', ['Section D: Conditions'], 3),
      ],
      meta,
    );
    expect(out.map((c) => c.clauseIds)).toEqual([['C.1'], ['C.2', 'C.3'], ['D.1']]);
    expect(out[1]).toMatchObject({ clauseId: 'C.2', pageStart: 2, pageEnd: 3 });
    expect(out[1].contentForEmbedding.split('\n')[0]).toBe('Sample Health Shield (Acme) › Section C: Exclusions');
    expect(out[1].content).toBe('C.2 Title\nShort rule.\n\nC.3 Title\nAnother short rule.');
  });

  it('chunks clauses containing special-token literals without throwing', () => {
    const out = chunkClauses([clause('C.9', 'The literal <|endoftext|> may appear in extracted text.')], meta);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('<|endoftext|>');
    expect(out[0].tokenCount).toBeGreaterThan(0);
  });

  it('never lets a merged group exceed maxTokens once the separator is counted', () => {
    const rules = (n: number, tail = '') => `${Array.from({ length: n }, (_, i) => `rule ${i}`).join(' ')}${tail}`;
    const opts = { maxTokens: 60, overlapTokens: 10, minTokens: 40 };
    const clauses = [clause('A.1', rules(1)), clause('A.2', rules(6, ' limit')), clause('A.3', rules(7, ' limit'))];
    const out = chunkClauses(clauses, meta, opts);
    expect(out.some((c) => c.clauseIds.length > 1)).toBe(true); // the cap is exercised on a real merge
    for (const c of out) expect(countTokens(c.content)).toBeLessThanOrEqual(opts.maxTokens);
    expect(out.flatMap((c) => c.clauseIds)).toEqual(['A.1', 'A.2', 'A.3']);
  });

  it('covers every fixture clause exactly once', async () => {
    const data = new Uint8Array(readFileSync(new URL('../../../../data/fixtures/sample-policy.pdf', import.meta.url)));
    const clauses = flattenClauses(buildSectionTree(removeRepeatedHeaderFooter(await extractPageLines(data))));
    const ids = chunkClauses(clauses, meta).flatMap((c) => c.clauseIds);
    expect(ids).toEqual(clauses.map((c) => c.clauseId));
  });
});
