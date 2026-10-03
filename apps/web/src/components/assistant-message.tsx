'use client';
import { createContext, memo, useContext, useMemo, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { linkifyCitations } from '@/lib/citations';
import type { ChatMeta, ClauseCiteUIMessage, SourceRef } from '@/lib/types';
import { CitationChip } from './citation-chip';

function partsOf(message: ClauseCiteUIMessage) {
  let sources: SourceRef[] = [];
  let meta: ChatMeta | undefined;
  let streamed = '';
  for (const p of message.parts) {
    if (p.type === 'data-sources') sources = p.data.sources;
    else if (p.type === 'data-meta') meta = p.data;
    else if (p.type === 'text') streamed += p.text;
  }
  return { sources, meta, streamed };
}

type CiteContextValue = {
  bySourceN: ReadonlyMap<number, SourceRef>;
  /** The citation numbers that may become chips: the server-validated ones once meta arrived. */
  valid: ReadonlySet<number>;
  onCite: (s: SourceRef) => void;
};
const CiteContext = createContext<CiteContextValue>({
  bySourceN: new Map(),
  valid: new Set(),
  onCite: () => {},
});

/**
 * Defined once at module level: react-markdown remounts every element of a custom component whose
 * identity changes, which would replace the chip under the pointer on each streamed delta and lose
 * the click. The per-message data reaches it through context instead.
 */
function MarkdownLink({ href, children }: ComponentPropsWithoutRef<'a'>) {
  const { bySourceN, valid, onCite } = useContext(CiteContext);
  const cite = /^#cite-(\d+)$/.exec(href ?? '');
  if (cite) {
    const n = Number(cite[1]);
    const source = valid.has(n) ? bySourceN.get(n) : undefined;
    // A forged or unvalidated marker (the model or a quoted clause can write one) stays plain text.
    return source ? <CitationChip n={n} onClick={() => onCite(source)} /> : <>[{children}]</>;
  }
  // Only real web links become anchors; an unsafe URL was already blanked by react-markdown.
  if (href && /^(https?:|mailto:)/i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return <>{children}</>;
}

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink };
// Images are never allowed: a remote URL in model output would be fetched by the browser as a beacon.
const DISALLOWED = ['img'];

const badge =
  'rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';

export const AssistantMessage = memo(function AssistantMessage({
  message,
  onCite,
  streaming = false,
}: {
  message: ClauseCiteUIMessage;
  onCite: (s: SourceRef) => void;
  /** True while this message is still being generated; otherwise a missing meta means it was cut short. */
  streaming?: boolean;
}) {
  const { sources, meta, streamed } = partsOf(message);
  // The streamed deltas are raw; once the server's cleaned answer arrives it replaces them.
  const text = meta?.answer ?? streamed;
  const valid = useMemo(
    () => new Set(meta ? meta.citations.map((c) => c.n) : sources.map((s) => s.n)),
    [meta, sources],
  );
  const cite = useMemo(
    () => ({ bySourceN: new Map(sources.map((s) => [s.n, s])), valid, onCite }),
    [sources, valid, onCite],
  );

  // A refusal is "<lead>\n\n<closest clauses list>\n\n<verify line>": the list is shown as buttons.
  const paragraphs = text.split(/\n{2,}/);
  const verifyLine = paragraphs.length > 1 ? paragraphs.at(-1) : undefined;

  return (
    <div className="space-y-2">
      {meta?.status === 'refused' ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <p className="font-medium">Not found in the selected policies</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">{paragraphs[0]}</p>
          {meta.suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-500">Closest clauses:</span>
              {meta.suggestions.map((s) => (
                <button
                  key={s.chunkId}
                  type="button"
                  onClick={() => onCite(s)}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  {s.documentTitle} · {s.clauseId}
                </button>
              ))}
            </div>
          )}
          {verifyLine && <p className="mt-2 text-xs text-zinc-500">{verifyLine}</p>}
        </div>
      ) : (
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <CiteContext.Provider value={cite}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={MARKDOWN_COMPONENTS}
              disallowedElements={DISALLOWED}
              unwrapDisallowed
            >
              {linkifyCitations(text, valid)}
            </ReactMarkdown>
          </CiteContext.Provider>
        </div>
      )}
      {meta?.uncited && meta.status === 'complete' && <span className={badge}>uncited</span>}
      {!meta && !streaming && <span className={badge}>incomplete</span>}
    </div>
  );
});
