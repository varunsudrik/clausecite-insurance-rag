import type { Clause } from './structure.js';
import { countTokens } from './tokens.js';

export interface ChunkDraft {
  chunkIndex: number;
  clauseId: string;
  clauseIds: string[];
  sectionPath: string[];
  pageStart: number;
  pageEnd: number;
  content: string;
  contentForEmbedding: string;
  tokenCount: number;
}

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
  minTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxTokens: 600, overlapTokens: 80, minTokens: 120 };

interface Piece {
  clauseIds: string[];
  titles: string[];
  sectionPath: string[];
  pageStart: number;
  pageEnd: number;
  content: string;
  tokens: number;
  split: boolean;
}

function hardSplit(sentence: string, maxTokens: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const word of sentence.split(/\s+/)) {
    if (cur.length && countTokens([...cur, word].join(' ')) > maxTokens) {
      out.push(cur.join(' '));
      cur = [];
    }
    cur.push(word);
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

export function splitText(text: string, maxTokens: number, overlapTokens: number): string[] {
  const sentences = text
    .split(/(?<=[.;:!?])\s+/)
    .filter(Boolean)
    .flatMap((s) => (countTokens(s) > maxTokens ? hardSplit(s, maxTokens) : [s]));
  const parts: string[] = [];
  let cur: string[] = [];
  for (const s of sentences) {
    if (cur.length && countTokens([...cur, s].join(' ')) > maxTokens) {
      parts.push(cur.join(' '));
      const keep: string[] = [];
      for (let i = cur.length - 1; i >= 0; i--) {
        if (countTokens([cur[i], ...keep].join(' ')) > overlapTokens) break;
        keep.unshift(cur[i]);
      }
      cur = countTokens([...keep, s].join(' ')) <= maxTokens ? keep : [];
    }
    cur.push(s);
  }
  if (cur.length) parts.push(cur.join(' '));
  return parts;
}

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function chunkClauses(
  clauses: Clause[],
  meta: { product: string; insurer: string },
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkDraft[] {
  const pieces: Piece[] = [];
  for (const c of clauses) {
    const base = { clauseIds: [c.clauseId], titles: [c.title], sectionPath: c.sectionPath, pageStart: c.pageStart, pageEnd: c.pageEnd };
    const whole = `${c.title}\n${c.text}`;
    const wholeTokens = countTokens(whole);
    if (wholeTokens <= opts.maxTokens) {
      pieces.push({ ...base, content: whole, tokens: wholeTokens, split: false });
      continue;
    }
    // -2: BPE token counts are not exactly additive across the title/body boundary.
    const budget = opts.maxTokens - countTokens(c.title) - 2;
    for (const part of splitText(c.text, budget, opts.overlapTokens)) {
      const content = `${c.title}\n${part}`;
      pieces.push({ ...base, content, tokens: countTokens(content), split: true });
    }
  }

  const merged: Piece[] = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    const mergeable =
      prev &&
      !p.split &&
      !prev.split &&
      p.tokens < opts.minTokens &&
      (prev.tokens < opts.minTokens || prev.clauseIds.length > 1) &&
      samePath(prev.sectionPath, p.sectionPath);
    // Count the joined text itself: the "\n\n" separator and BPE merges at the join make sums inexact.
    const joined = mergeable ? `${prev.content}\n\n${p.content}` : '';
    const joinedTokens = mergeable ? countTokens(joined) : 0;
    if (mergeable && joinedTokens <= opts.maxTokens) {
      prev.clauseIds.push(...p.clauseIds);
      prev.titles.push(...p.titles);
      prev.content = joined;
      prev.tokens = joinedTokens;
      prev.pageStart = Math.min(prev.pageStart, p.pageStart);
      prev.pageEnd = Math.max(prev.pageEnd, p.pageEnd);
    } else {
      merged.push({ ...p, clauseIds: [...p.clauseIds], titles: [...p.titles] });
    }
  }

  return merged.map((p, chunkIndex) => {
    const trail =
      p.clauseIds.length > 1
        ? p.sectionPath.length
          ? p.sectionPath
          : [p.titles.join(' / ')]
        : [...p.sectionPath, p.titles[0]];
    const header = [`${meta.product} (${meta.insurer})`, ...trail].join(' › ');
    const contentForEmbedding = `${header}\n\n${p.content}`;
    return {
      chunkIndex,
      clauseId: p.clauseIds[0],
      clauseIds: p.clauseIds,
      sectionPath: p.sectionPath,
      pageStart: p.pageStart,
      pageEnd: p.pageEnd,
      content: p.content,
      contentForEmbedding,
      tokenCount: countTokens(contentForEmbedding),
    };
  });
}
