import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractPageLines,
  removeRepeatedHeaderFooter,
  type Line,
  type PageLines,
} from './pdf-lines.js';
import { bodyFontSize, buildSectionTree, detectHeading, flattenClauses } from './structure.js';

const L = (text: string, fontSize = 10, bold = false): Line => ({
  text,
  fontSize,
  bold,
  x: 50,
  y: 0,
});

describe('detectHeading', () => {
  it('detects sections and lettered/numeric clauses with levels', () => {
    expect(detectHeading(L('Section C: Exclusions', 13, true), 10)).toMatchObject({
      level: 1,
      clauseId: 'C',
    });
    expect(detectHeading(L('C.2.1 Disclosure', 11, true), 10)).toMatchObject({
      level: 3,
      clauseId: 'C.2.1',
      title: 'C.2.1 Disclosure',
      rest: '',
    });
    expect(detectHeading(L('4.2 Room rent', 10, true), 10)).toMatchObject({
      level: 2,
      clauseId: '4.2',
    });
    expect(detectHeading(L('4. Exclusions', 12, true), 10)).toMatchObject({
      level: 1,
      clauseId: '4',
    });
  });

  it('treats unnumbered strong lines as headings and plain text as body', () => {
    expect(detectHeading(L('GENERAL CONDITIONS', 10), 10)).toMatchObject({
      clauseId: null,
      level: 2,
    });
    expect(detectHeading(L('Policy Wording', 16, true), 10)).toMatchObject({
      clauseId: null,
      level: 1,
    });
    expect(detectHeading(L('The Company shall pay the claim.', 10), 10)).toBeNull();
    expect(detectHeading(L('(i) cataract;', 10), 10)).toBeNull();
    expect(detectHeading(L('4. the insured shall notify', 10), 10)).toBeNull();
    expect(detectHeading(L('Part of the claim is payable by the insured.', 10), 10)).toBeNull();
  });

  it('splits a long numbered paragraph into short title + body', () => {
    const text =
      '5.3 ' +
      'Any claim for expenses incurred outside India is excluded unless specifically covered. '.repeat(
        2,
      );
    const h = detectHeading(L(text.trim(), 10), 10)!;
    expect(h.clauseId).toBe('5.3');
    expect(h.title.length).toBeLessThanOrEqual(70);
    expect(h.rest).toContain('outside India');
  });

  describe('false-positive gating (fix round 1)', () => {
    it('does not treat body sentences starting with Section/Part as headings', () => {
      expect(detectHeading(L('Section 45 of the Insurance Act, 1938 applies.', 10), 10)).toBeNull();
      expect(detectHeading(L('Part A of the schedule applies to you.', 10), 10)).toBeNull();
      expect(detectHeading(L('Section C above shall prevail.', 10), 10)).toBeNull();
    });

    it('still accepts a plain-font short Section heading and dotted section ids', () => {
      expect(detectHeading(L('Section C: Exclusions', 10), 10)).toMatchObject({
        level: 1,
        clauseId: 'C',
      });
      expect(detectHeading(L('Section 3.1 Definitions', 13, true), 10)).toMatchObject({
        level: 1,
        clauseId: '3.1',
      });
    });

    it('does not treat wrapped numeric body lines as clause headings', () => {
      expect(detectHeading(L('1.5 times the sum insured per day', 10), 10)).toBeNull();
      expect(detectHeading(L('2.5 lakh is the maximum payable.', 10), 10)).toBeNull();
      expect(detectHeading(L('30.06.2024 is the cut-off date', 10), 10)).toBeNull();
    });

    it('rejects ids with an implausibly large numeric part even when bold', () => {
      expect(detectHeading(L('30.06.2024 Cut-off date', 11, true), 10)).toBeNull();
      expect(detectHeading(L('A.150 Something', 11, true), 10)).toBeNull();
    });

    it('keeps capitalised and strong numbered lines as headings', () => {
      expect(detectHeading(L('B.2 Room Rent', 11, true), 10)).toMatchObject({
        level: 2,
        clauseId: 'B.2',
      });
      expect(detectHeading(L('4.3 \u201cHospital\u201d means a place.', 10), 10)).toMatchObject({
        clauseId: '4.3',
      });
    });

    it('never treats list markers as headings, whatever the font', () => {
      expect(detectHeading(L('(i) Cataract', 10, true), 10)).toBeNull();
      expect(detectHeading(L('(A) PRE-EXISTING CONDITIONS', 10), 10)).toBeNull();
      expect(detectHeading(L('(A) PRE-EXISTING CONDITIONS', 14, true), 10)).toBeNull();
      expect(detectHeading(L('(iv) hernia', 10), 10)).toBeNull();
      expect(detectHeading(L('(a) knee replacement', 12, true), 10)).toBeNull();
      expect(detectHeading(L('(1) Waiting period', 10, true), 10)).toBeNull();
    });
  });
});

describe('buildSectionTree + flattenClauses', () => {
  it('nests clauses and tracks pages on synthetic input', () => {
    const pages: PageLines[] = [
      {
        page: 1,
        lines: [
          L('Intro text before headings.'),
          L('Section A: Definitions', 13, true),
          L('A.1 Hospital', 11, true),
          L('Hospital means a place.'),
        ],
      },
      {
        page: 2,
        lines: [
          L('continues on page two.'),
          L('A.1.1 Day care centre', 11, true),
          L('A centre for day care.'),
        ],
      },
    ];
    const clauses = flattenClauses(buildSectionTree(pages));
    expect(clauses.map((c) => c.clauseId)).toEqual(['preamble', 'A.1', 'A.1.1']);
    expect(clauses[1]).toMatchObject({
      sectionPath: ['Section A: Definitions'],
      pageStart: 1,
      pageEnd: 2,
    });
    expect(clauses[1].text).toBe('Hospital means a place.\ncontinues on page two.');
    expect(clauses[2].sectionPath).toEqual(['Section A: Definitions', 'A.1 Hospital']);
  });

  it('gives unnumbered headings fallback ids', () => {
    const pages: PageLines[] = [
      {
        page: 1,
        lines: [
          L('BENEFITS', 14, true),
          L('Covers a lot of things.'),
          L('NOTES', 14, true),
          L('Some notes.'),
        ],
      },
    ];
    expect(flattenClauses(buildSectionTree(pages)).map((c) => c.clauseId)).toEqual(['s1', 's2']);
  });

  it('keeps wrapped numeric body lines inside the enclosing clause', () => {
    const pages: PageLines[] = [
      {
        page: 1,
        lines: [
          L('Section B: Coverage', 13, true),
          L('B.2 Room Rent', 11, true),
          L('Room rent is covered up to'),
          L('1.5 times the sum insured per day'),
          L('for ICU.'),
        ],
      },
    ];
    const clauses = flattenClauses(buildSectionTree(pages));
    expect(clauses.map((c) => c.clauseId)).toEqual(['B.2']);
    expect(clauses[0].text).toBe(
      'Room rent is covered up to\n1.5 times the sum insured per day\nfor ICU.',
    );
  });

  it('keeps list markers in the clause body even when bold or capitalised', () => {
    const pages: PageLines[] = [
      {
        page: 1,
        lines: [
          L('C.3 Specified Disease Waiting Period', 11, true),
          L('Covered only after 24 months for:'),
          L('(i) Cataract', 10, true),
          L('(A) PRE-EXISTING CONDITIONS'),
        ],
      },
    ];
    const clauses = flattenClauses(buildSectionTree(pages));
    expect(clauses.map((c) => c.clauseId)).toEqual(['C.3']);
    expect(clauses[0].text).toContain('(i) Cataract');
    expect(clauses[0].text).toContain('(A) PRE-EXISTING CONDITIONS');
  });

  it('starts the preamble on the first page that contributed preamble text', () => {
    const pages: PageLines[] = [
      { page: 1, lines: [] },
      {
        page: 2,
        lines: [
          L('Preamble text on page two.'),
          L('Section A: Definitions', 13, true),
          L('A.1 Hospital', 11, true),
          L('Hospital means a place.'),
        ],
      },
    ];
    const clauses = flattenClauses(buildSectionTree(pages));
    expect(clauses[0]).toMatchObject({ clauseId: 'preamble', pageStart: 2, pageEnd: 2 });
  });

  it('numbers nested unnumbered headings with dotted fallback ids', () => {
    const pages: PageLines[] = [
      {
        page: 1,
        lines: [
          L('BENEFITS', 16, true),
          L('Covers a lot of things in this policy document.'),
          L('COVERED ITEMS'),
          L('Hospital room and nursing charges are covered.'),
          L('EXCLUDED ITEMS'),
          L('Cosmetic procedures are not covered at all.'),
          L('NOTES', 14, true),
          L('Some notes about the policy document.'),
        ],
      },
    ];
    expect(flattenClauses(buildSectionTree(pages)).map((c) => c.clauseId)).toEqual([
      's1',
      's1.1',
      's1.2',
      's2',
    ]);
  });

  it('parses the fixture policy into the expected clauses', async () => {
    const data = new Uint8Array(
      readFileSync(new URL('../../../../data/fixtures/sample-policy.pdf', import.meta.url)),
    );
    const clauses = flattenClauses(
      buildSectionTree(removeRepeatedHeaderFooter(await extractPageLines(data))),
    );
    expect(clauses.map((c) => c.clauseId)).toEqual([
      'A.1',
      'A.2',
      'B.1',
      'B.2',
      'B.3',
      'C.1',
      'C.2',
      'C.2.1',
      'C.3',
      'D.1',
      'D.2',
    ]);
    const byId = Object.fromEntries(clauses.map((c) => [c.clauseId, c]));
    expect(byId['B.2']).toMatchObject({ pageStart: 2, sectionPath: ['Section B: Coverage'] });
    expect(byId['C.2.1'].sectionPath).toEqual([
      'Section C: Exclusions',
      'C.2 Pre-existing Diseases',
    ]);
    const flat = (id: string) => byId[id].text.replace(/\n/g, ' ');
    expect(flat('C.3')).toContain('(i) cataract');
    expect(flat('B.1')).toContain('24 consecutive hours');
  });
});

describe('bodyFontSize', () => {
  it('is the char-weighted median font size, not the median of line sizes', () => {
    const pages: PageLines[] = [
      { page: 1, lines: [L('ab', 9), L('cd', 9), L('ef', 9), L('x'.repeat(40), 12)] },
    ];
    expect(bodyFontSize(pages)).toBe(12);
  });

  it('picks the dominant body size in a typical page and defaults to 10 when empty', () => {
    const pages: PageLines[] = [
      {
        page: 1,
        lines: [L('Title', 16, true), L('y'.repeat(60), 10), L('z'.repeat(60), 10), L('Footer', 9)],
      },
    ];
    expect(bodyFontSize(pages)).toBe(10);
    expect(bodyFontSize([])).toBe(10);
  });
});
