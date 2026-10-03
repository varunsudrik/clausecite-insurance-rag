import type { Citation } from '../db/schema.js';

export interface CitableSource {
  chunkId: string;
  documentId: string;
  clauseId: string;
  pageStart: number;
  pageEnd: number;
}

const GROUP = String.raw`\[\d+(?:\s*,\s*\d+)*\]`;
/** A run of adjacent markers ("[1][3]", "[2, 4]") with the single space or tab that precedes it. */
const RUN_RE = new RegExp(String.raw`([ \t]?)((?:${GROUP})+)`, 'g');
const GROUP_RE = new RegExp(GROUP, 'g');

/**
 * Keeps `[n]` markers that point at a real source, normalises `[n, m]` to `[n][m]`, and removes the rest.
 * Whitespace cleanup is local to the markers: a run with no valid number disappears together with the one
 * space before it ("maybe [7]." becomes "maybe."), and nothing else in the text (list indentation, code
 * blocks, table alignment) is touched.
 */
export function validateCitations(
  text: string,
  sources: CitableSource[],
): { text: string; citations: Citation[]; invalidMarkers: number[] } {
  const invalid = new Set<number>();
  const order: number[] = [];
  const cleaned = text.replace(RUN_RE, (_m, space: string, run: string) => {
    const kept = run.replace(GROUP_RE, (group) => {
      const numbers = new Set(
        group
          .slice(1, -1)
          .split(',')
          .map((s) => Number(s.trim())),
      );
      let out = '';
      for (const n of numbers) {
        if (n < 1 || n > sources.length) {
          invalid.add(n);
          continue;
        }
        if (!order.includes(n)) order.push(n);
        out += `[${n}]`;
      }
      return out;
    });
    return kept === '' ? '' : space + kept;
  });
  const citations = order.map((n) => {
    const s = sources[n - 1];
    return {
      n,
      chunkId: s.chunkId,
      documentId: s.documentId,
      clauseId: s.clauseId,
      pageStart: s.pageStart,
      pageEnd: s.pageEnd,
    };
  });
  return { text: cleaned, citations, invalidMarkers: [...invalid] };
}
