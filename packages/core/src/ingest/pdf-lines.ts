import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { IngestError } from './errors.js';

const require = createRequire(import.meta.url);

GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// Without this pdf.js warns that standard-14 font data is missing and falls back to generic fonts.
const STANDARD_FONT_DATA_URL =
  join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + sep;

export interface Line {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  bold: boolean;
}

export interface PageLines {
  page: number;
  lines: Line[];
}

interface Item {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  bold: boolean;
}

interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
}

const isTextItem = (it: unknown): it is RawTextItem =>
  typeof it === 'object' && it !== null && 'str' in it && 'transform' in it;

export async function extractPageLines(
  data: Uint8Array,
  opts: { maxPages?: number } = {},
): Promise<PageLines[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(data), // pdf.js detaches the buffer it receives
    disableFontFace: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    await loadingTask.destroy().catch(() => undefined);
    throw new IngestError('PDF_PARSE_FAILED', `cannot open PDF: ${(err as Error).message}`, {
      cause: err,
    });
  }
  try {
    if (opts.maxPages && doc.numPages > opts.maxPages) {
      throw new IngestError('TOO_MANY_PAGES', `${doc.numPages} pages exceeds ${opts.maxPages}`);
    }
    const pages: PageLines[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      await page.getOperatorList(); // loads fonts into commonObjs so real font names are readable
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const it of content.items) {
        if (!isTextItem(it) || it.str.trim().length === 0) continue;
        items.push({
          text: it.str,
          x: it.transform[4],
          y: it.transform[5],
          width: it.width,
          fontSize: Math.round(Math.hypot(it.transform[2], it.transform[3]) * 10) / 10,
          bold: isBold(page, it.fontName),
        });
      }
      pages.push({ page: p, lines: groupIntoLines(items) });
      page.cleanup();
    }
    return pages;
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError('PDF_PARSE_FAILED', `cannot read PDF: ${(err as Error).message}`, {
      cause: err,
    });
  } finally {
    await loadingTask.destroy();
  }
}

function isBold(page: { commonObjs: { get(id: string): unknown } }, fontName: string): boolean {
  try {
    const font = page.commonObjs.get(fontName) as { name?: string } | undefined;
    return /bold|black|heavy|semibold/i.test(font?.name ?? '');
  } catch {
    return false;
  }
}

function groupIntoLines(items: Item[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: { y: number; items: Item[] }[] = [];
  for (const it of sorted) {
    const tolerance = Math.max(1, it.fontSize * 0.5);
    const row = rows.find((r) => Math.abs(r.y - it.y) <= tolerance);
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map(({ y, items: rowItems }) => {
      rowItems.sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd: number | null = null;
      for (const it of rowItems) {
        const gap = prevEnd === null ? 0 : it.x - prevEnd;
        if (prevEnd !== null && !text.endsWith(' ') && !it.text.startsWith(' ') && gap > it.fontSize * 0.15) {
          text += ' ';
        }
        text += it.text;
        prevEnd = it.x + it.width;
      }
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        x: rowItems[0].x,
        y,
        fontSize: Math.max(...rowItems.map((i) => i.fontSize)),
        bold: rowItems.every((i) => i.bold),
      };
    })
    .filter((l) => l.text.length > 0);
}

const normalize = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/** Removes lines in the top-2/bottom-2 positions whose (digit-normalised) text repeats on >50% of pages. */
export function removeRepeatedHeaderFooter(pages: PageLines[]): PageLines[] {
  if (pages.length < 3) return pages;
  const counts = new Map<string, number>();
  for (const p of pages) {
    const edge = new Set([...p.lines.slice(0, 2), ...p.lines.slice(-2)].map((l) => normalize(l.text)));
    for (const key of edge) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = new Set(
    [...counts].filter(([, c]) => c > pages.length / 2).map(([key]) => key),
  );
  return pages.map((p) => {
    const n = p.lines.length;
    return {
      ...p,
      lines: p.lines.filter((l, i) => !((i < 2 || i >= n - 2) && repeated.has(normalize(l.text)))),
    };
  });
}

export function assertTextLayer(pages: PageLines[], minAvgChars = 200): void {
  const total = pages.reduce((s, p) => s + p.lines.reduce((t, l) => t + l.text.length, 0), 0);
  const avg = total / Math.max(pages.length, 1);
  if (pages.length === 0 || avg < minAvgChars) {
    throw new IngestError(
      'NO_TEXT_LAYER',
      `average ${Math.round(avg)} chars/page; scanned PDFs (no text layer) are not supported`,
    );
  }
}
