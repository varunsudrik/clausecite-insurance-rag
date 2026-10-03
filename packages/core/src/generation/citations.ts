import type { Citation } from '../db/schema.js';

export interface CitableSource {
  chunkId: string;
  documentId: string;
  clauseId: string;
  pageStart: number;
  pageEnd: number;
}

const MARKER_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

export function validateCitations(
  text: string,
  sources: CitableSource[],
): { text: string; citations: Citation[]; invalidMarkers: number[] } {
  const invalid = new Set<number>();
  const order: number[] = [];
  const replaced = text.replace(MARKER_RE, (_m, list: string) => {
    const valid = list
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => {
        if (n < 1 || n > sources.length) {
          invalid.add(n);
          return false;
        }
        if (!order.includes(n)) order.push(n);
        return true;
      });
    return valid.map((n) => `[${n}]`).join('');
  });
  const cleaned = replaced.replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
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
