import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IngestError } from './errors.js';
import {
  assertTextLayer,
  extractPageLines,
  removeRepeatedHeaderFooter,
  type PageLines,
} from './pdf-lines.js';

const FIXTURE = new URL('../../../../data/fixtures/sample-policy.pdf', import.meta.url);
const load = () => new Uint8Array(readFileSync(FIXTURE));

describe('extractPageLines', () => {
  it('extracts ordered lines with font size and boldness per page', async () => {
    const pages = await extractPageLines(load());
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
    const p2 = pages[1].lines;
    const heading = p2.find((l) => l.text === 'B.2 Room Rent');
    expect(heading).toMatchObject({ fontSize: 11, bold: true });
    const body = p2.find((l) => l.text.startsWith('Room rent, boarding'));
    expect(body).toMatchObject({ fontSize: 10, bold: false });
    // top-to-bottom order
    expect(p2.indexOf(heading!)).toBeLessThan(p2.indexOf(body!));
  });

  it('rejects documents above maxPages', async () => {
    await expect(extractPageLines(load(), { maxPages: 2 })).rejects.toMatchObject({
      code: 'TOO_MANY_PAGES',
    });
  });

  it('wraps unparseable bytes as PDF_PARSE_FAILED', async () => {
    await expect(extractPageLines(new TextEncoder().encode('not a pdf'))).rejects.toMatchObject({
      code: 'PDF_PARSE_FAILED',
    });
  });
});

describe('removeRepeatedHeaderFooter', () => {
  it('drops the running header and page-number footer from every page', async () => {
    const pages = removeRepeatedHeaderFooter(await extractPageLines(load()));
    for (const p of pages) {
      expect(p.lines.some((l) => l.text.includes('Policy Wording') && l.fontSize === 9)).toBe(
        false,
      );
      expect(p.lines.some((l) => /^Page \d+ of 4$/.test(l.text))).toBe(false);
    }
    expect(pages[0].lines[0].text).toBe('SAMPLE HEALTH SHIELD POLICY WORDING');
  });
});

describe('assertTextLayer', () => {
  const page = (text: string, n = 1): PageLines => ({
    page: n,
    lines: [{ text, x: 0, y: 0, fontSize: 10, bold: false }],
  });
  it('throws NO_TEXT_LAYER when pages carry almost no text', () => {
    expect(() => assertTextLayer([page('x'), page('y', 2)])).toThrow(IngestError);
    try {
      assertTextLayer([page('x')]);
    } catch (e) {
      expect((e as IngestError).code).toBe('NO_TEXT_LAYER');
      expect((e as IngestError).retryable).toBe(false);
    }
  });
  it('passes for text-rich pages', () => {
    expect(() => assertTextLayer([page('a'.repeat(300))])).not.toThrow();
  });
});
