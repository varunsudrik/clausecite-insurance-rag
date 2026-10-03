import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPageLines, removeRepeatedHeaderFooter, type Line, type PageLines } from './pdf-lines.js';
import { buildSectionTree, detectHeading, flattenClauses } from './structure.js';

const L = (text: string, fontSize = 10, bold = false): Line => ({ text, fontSize, bold, x: 50, y: 0 });

describe('detectHeading', () => {
  it('detects sections and lettered/numeric clauses with levels', () => {
    expect(detectHeading(L('Section C: Exclusions', 13, true), 10)).toMatchObject({ level: 1, clauseId: 'C' });
    expect(detectHeading(L('C.2.1 Disclosure', 11, true), 10)).toMatchObject({ level: 3, clauseId: 'C.2.1', title: 'C.2.1 Disclosure', rest: '' });
    expect(detectHeading(L('4.2 Room rent', 10, true), 10)).toMatchObject({ level: 2, clauseId: '4.2' });
    expect(detectHeading(L('4. Exclusions', 12, true), 10)).toMatchObject({ level: 1, clauseId: '4' });
  });

  it('treats unnumbered strong lines as headings and plain text as body', () => {
    expect(detectHeading(L('GENERAL CONDITIONS', 10), 10)).toMatchObject({ clauseId: null, level: 2 });
    expect(detectHeading(L('Policy Wording', 16, true), 10)).toMatchObject({ clauseId: null, level: 1 });
    expect(detectHeading(L('The Company shall pay the claim.', 10), 10)).toBeNull();
    expect(detectHeading(L('(i) cataract;', 10), 10)).toBeNull();
    expect(detectHeading(L('4. the insured shall notify', 10), 10)).toBeNull();
    expect(detectHeading(L('Part of the claim is payable by the insured.', 10), 10)).toBeNull();
  });

  it('splits a long numbered paragraph into short title + body', () => {
    const text = '5.3 ' + 'Any claim for expenses incurred outside India is excluded unless specifically covered. '.repeat(2);
    const h = detectHeading(L(text.trim(), 10), 10)!;
    expect(h.clauseId).toBe('5.3');
    expect(h.title.length).toBeLessThanOrEqual(70);
    expect(h.rest).toContain('outside India');
  });
});

describe('buildSectionTree + flattenClauses', () => {
  it('nests clauses and tracks pages on synthetic input', () => {
    const pages: PageLines[] = [
      { page: 1, lines: [L('Intro text before headings.'), L('Section A: Definitions', 13, true), L('A.1 Hospital', 11, true), L('Hospital means a place.')] },
      { page: 2, lines: [L('continues on page two.'), L('A.1.1 Day care centre', 11, true), L('A centre for day care.')] },
    ];
    const clauses = flattenClauses(buildSectionTree(pages));
    expect(clauses.map((c) => c.clauseId)).toEqual(['preamble', 'A.1', 'A.1.1']);
    expect(clauses[1]).toMatchObject({ sectionPath: ['Section A: Definitions'], pageStart: 1, pageEnd: 2 });
    expect(clauses[1].text).toBe('Hospital means a place.\ncontinues on page two.');
    expect(clauses[2].sectionPath).toEqual(['Section A: Definitions', 'A.1 Hospital']);
  });

  it('gives unnumbered headings fallback ids', () => {
    const pages: PageLines[] = [
      { page: 1, lines: [L('BENEFITS', 14, true), L('Covers a lot of things.'), L('NOTES', 14, true), L('Some notes.')] },
    ];
    expect(flattenClauses(buildSectionTree(pages)).map((c) => c.clauseId)).toEqual(['s1', 's2']);
  });

  it('parses the fixture policy into the expected clauses', async () => {
    const data = new Uint8Array(readFileSync(new URL('../../../../data/fixtures/sample-policy.pdf', import.meta.url)));
    const clauses = flattenClauses(buildSectionTree(removeRepeatedHeaderFooter(await extractPageLines(data))));
    expect(clauses.map((c) => c.clauseId)).toEqual(['A.1', 'A.2', 'B.1', 'B.2', 'B.3', 'C.1', 'C.2', 'C.2.1', 'C.3', 'D.1', 'D.2']);
    const byId = Object.fromEntries(clauses.map((c) => [c.clauseId, c]));
    expect(byId['B.2']).toMatchObject({ pageStart: 2, sectionPath: ['Section B: Coverage'] });
    expect(byId['C.2.1'].sectionPath).toEqual(['Section C: Exclusions', 'C.2 Pre-existing Diseases']);
    const flat = (id: string) => byId[id].text.replace(/\n/g, ' ');
    expect(flat('C.3')).toContain('(i) cataract');
    expect(flat('B.1')).toContain('24 consecutive hours');
  });
});
