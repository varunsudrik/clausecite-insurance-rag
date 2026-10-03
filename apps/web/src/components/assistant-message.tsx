'use client';
import { createContext, useContext, useMemo, type ComponentPropsWithoutRef } from 'react';
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
  onCite: (s: SourceRef) => void;
};
const CiteContext = createContext<CiteContextValue>({ bySourceN: new Map(), onCite: () => {} });

/**
 * Defined once at module level: react-markdown remounts every element of a custom component whose
 * identity changes, which would replace the chip under the pointer on each streamed delta and lose
 * the click. The per-message data reaches it through context instead.
 */
function MarkdownLink({ href, children }: ComponentPropsWithoutRef<'a'>) {
  const { bySourceN, onCite } = useContext(CiteContext);
  const m = /^#cite-(\d+)$/.exec(href ?? '');
  const source = m ? bySourceN.get(Number(m[1])) : undefined;
  if (m && source) return <CitationChip n={Number(m[1])} onClick={() => onCite(source)} />;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink };

export function AssistantMessage({
  message,
  onCite,
}: {
  message: ClauseCiteUIMessage;
  onCite: (s: SourceRef) => void;
}) {
  const { sources, meta, streamed } = partsOf(message);
  // The streamed deltas are raw; once the server's cleaned answer arrives it replaces them.
  const text = meta?.answer ?? streamed;
  const valid = new Set(meta ? meta.citations.map((c) => c.n) : sources.map((s) => s.n));
  const cite = useMemo(
    () => ({ bySourceN: new Map(sources.map((s) => [s.n, s])), onCite }),
    [sources, onCite],
  );

  return (
    <div className="space-y-2">
      {meta?.status === 'refused' ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <p className="font-medium">Not found in the selected policies</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">{text.split('\n')[0]}</p>
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
        </div>
      ) : (
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <CiteContext.Provider value={cite}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
              {linkifyCitations(text, valid)}
            </ReactMarkdown>
          </CiteContext.Provider>
        </div>
      )}
      {meta?.uncited && meta.status === 'complete' && (
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          uncited
        </span>
      )}
    </div>
  );
}
