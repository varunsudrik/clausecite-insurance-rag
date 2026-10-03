import type { Line, PageLines } from './pdf-lines.js';

export interface Heading {
  level: number;
  clauseId: string | null;
  title: string;
  rest: string;
}

export interface SectionNode {
  title: string;
  clauseId: string;
  level: number;
  pageStart: number;
  pageEnd: number;
  text: string;
  children: SectionNode[];
}

export interface Clause {
  clauseId: string;
  title: string;
  sectionPath: string[];
  pageStart: number;
  pageEnd: number;
  text: string;
}

// Case-sensitive on purpose: `Part of the claim…` must not become a heading.
const SECTION_RE =
  /^(?:Section|SECTION|Part|PART)\s+([A-Z]|[IVX]{1,4}|\d{1,2}(?:\.\d+)*)\b\s*[:.\-–—]?\s*(.*)$/;
const LETTER_CLAUSE_RE = /^([A-Z])\.(\d+(?:\.\d+)*)\.?\s+(\S.*)$/;
const NUMERIC_CLAUSE_RE = /^(\d+(?:\.\d+)+)\.?\s+(\S.*)$/;
const SINGLE_NUMBER_RE = /^(\d{1,2})\.\s+(\S.*)$/;
const TITLE_MAX = 100;
// `(i) cataract`, `(a)`, `(A)`, `(1)`: list markers are body text whatever the font (refinement #3).
const LIST_MARKER_RE = /^\((?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6}|[a-zA-Z]|\d{1,3})\)(?=\s|$)/;
// A real clause title starts with a capital, optionally after an opening quote/bracket.
const CAPITALISED_RE = /^(?:["'\u201c\u2018([{]\s*)?\p{Lu}/u;
const MAX_ID_PART = 99;
const SECTION_LINE_MAX = 60;

function isStrong(line: Line, body: number): boolean {
  const t = line.text.trim();
  const allCaps =
    /[A-Z]/.test(t) &&
    t === t.toUpperCase() &&
    t.length >= 4 &&
    t.length <= 80 &&
    !/[.:;,]$/.test(t);
  return line.fontSize >= body * 1.15 || (line.bold && t.length <= 80) || allCaps;
}

function numbered(line: Line, body: number, clauseId: string, afterId: string): Heading {
  const text = line.text.trim();
  const paragraph =
    text.length > TITLE_MAX || (!line.bold && line.fontSize <= body && /[.;]$/.test(text));
  if (!paragraph) return { level: clauseId.split('.').length, clauseId, title: text, rest: '' };
  const short = afterId.length > 60 ? `${afterId.slice(0, 60).trimEnd()}…` : afterId;
  return {
    level: clauseId.split('.').length,
    clauseId,
    title: `${clauseId} ${short}`,
    rest: afterId,
  };
}

// Wrapped body lines such as `1.5 times the sum insured` or `30.06.2024 is the cut-off date`
// look like numbered clauses; only plausible ids followed by a capitalised title (or a strong font) count.
function plausibleClause(
  line: Line,
  body: number,
  numericParts: string[],
  afterId: string,
): boolean {
  if (numericParts.some((p) => Number(p) > MAX_ID_PART)) return false;
  return isStrong(line, body) || CAPITALISED_RE.test(afterId);
}

// A `Section X` / `Part X` line is a heading when it is visually strong, or short, not sentence-like
// and followed by nothing or a capitalised title. Body sentences such as `Section 45 of the Act applies.` fail.
function isSectionHeading(line: Line, body: number, text: string, afterId: string): boolean {
  if (isStrong(line, body)) return true;
  if (text.length > SECTION_LINE_MAX || /[.;,]$/.test(text)) return false;
  return afterId === '' || CAPITALISED_RE.test(afterId);
}

export function detectHeading(line: Line, bodyFontSize: number): Heading | null {
  const text = line.text.trim();
  if (LIST_MARKER_RE.test(text)) return null;
  let m = SECTION_RE.exec(text);
  if (m && isSectionHeading(line, bodyFontSize, text, m[2])) {
    return { level: 1, clauseId: m[1].toUpperCase(), title: text, rest: '' };
  }
  m = LETTER_CLAUSE_RE.exec(text);
  if (m) {
    if (!plausibleClause(line, bodyFontSize, m[2].split('.'), m[3])) return null;
    return numbered(line, bodyFontSize, `${m[1]}.${m[2]}`, m[3]);
  }
  m = NUMERIC_CLAUSE_RE.exec(text);
  if (m) {
    if (!plausibleClause(line, bodyFontSize, m[1].split('.'), m[2])) return null;
    return numbered(line, bodyFontSize, m[1], m[2]);
  }
  m = SINGLE_NUMBER_RE.exec(text);
  if (m && isStrong(line, bodyFontSize) && /^[A-Z]/.test(m[2])) {
    return { level: 1, clauseId: m[1], title: text, rest: '' };
  }
  if (isStrong(line, bodyFontSize)) {
    return {
      level: line.fontSize >= bodyFontSize * 1.3 ? 1 : 2,
      clauseId: null,
      title: text,
      rest: '',
    };
  }
  return null;
}

export function bodyFontSize(pages: PageLines[]): number {
  const sizes = pages
    .flatMap((p) => p.lines.map((l) => ({ size: l.fontSize, chars: l.text.length })))
    .sort((a, b) => a.size - b.size);
  const total = sizes.reduce((s, x) => s + x.chars, 0);
  let acc = 0;
  for (const x of sizes) {
    acc += x.chars;
    if (acc >= total / 2) return x.size;
  }
  return 10;
}

export function buildSectionTree(pages: PageLines[]): SectionNode {
  const body = bodyFontSize(pages);
  const root: SectionNode = {
    title: '',
    clauseId: 'root',
    level: 0,
    pageStart: 1,
    pageEnd: 1,
    text: '',
    children: [],
  };
  const unnamed = new Set<SectionNode>();
  const stack: SectionNode[] = [root];
  for (const { page, lines } of pages) {
    for (const line of lines) {
      const h = detectHeading(line, body);
      if (h) {
        while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
        const node: SectionNode = {
          title: h.title,
          clauseId: h.clauseId ?? '',
          level: h.level,
          pageStart: page,
          pageEnd: page,
          text: h.rest,
          children: [],
        };
        if (h.clauseId === null) unnamed.add(node);
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      } else {
        const cur = stack[stack.length - 1];
        // The root only gets a meaningful page range from the preamble text it actually collects.
        if (cur === root && !cur.text.trim() && line.text.trim()) cur.pageStart = page;
        cur.text = cur.text ? `${cur.text}\n${line.text}` : line.text;
        cur.pageEnd = page;
      }
    }
  }
  const assign = (node: SectionNode, prefix: string) =>
    node.children.forEach((child, i) => {
      const path = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      if (unnamed.has(child)) child.clauseId = `s${path}`;
      assign(child, path);
    });
  assign(root, '');
  return root;
}

export function flattenClauses(root: SectionNode): Clause[] {
  const out: Clause[] = [];
  if (root.text.trim()) {
    out.push({
      clauseId: 'preamble',
      title: 'Preamble',
      sectionPath: [],
      pageStart: root.pageStart,
      pageEnd: root.pageEnd,
      text: root.text.trim(),
    });
  }
  const visit = (node: SectionNode, path: string[]) => {
    if (node.text.trim()) {
      out.push({
        clauseId: node.clauseId,
        title: node.title,
        sectionPath: path,
        pageStart: node.pageStart,
        pageEnd: node.pageEnd,
        text: node.text.trim(),
      });
    }
    for (const child of node.children) visit(child, [...path, node.title]);
  };
  for (const child of root.children) visit(child, []);
  return out;
}
