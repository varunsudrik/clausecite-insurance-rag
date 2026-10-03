'use client';
import dynamic from 'next/dynamic';
import { useEffect, useId, useRef, useState } from 'react';
import type { SourceRef } from '@/lib/types';

// pdf.js touches the DOM (and a web worker) at import time, so the viewer is client-only.
const PdfViewer = dynamic(() => import('./pdf-viewer'), {
  ssr: false,
  loading: () => <p className="text-sm text-zinc-500">Loading viewer…</p>,
});

export function CitationPanel({
  source,
  onClose,
  sheet = false,
}: {
  source: SourceRef | null;
  onClose: () => void;
  /** True while the panel is shown as a bottom sheet over the chat: it then is a non-modal dialog. */
  sheet?: boolean;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // The clause whose PDF is open. It resets when another clause is picked or the panel is dismissed,
  // so a new citation never opens with a viewer (and a page) left over from the previous one.
  const [pdfFor, setPdfFor] = useState<string | null>(null);
  const chunkId = source?.chunkId ?? null;
  if (pdfFor !== null && pdfFor !== chunkId) setPdfFor(null);

  // Hand focus to the panel when a clause opens or changes, so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (chunkId) heading.current?.focus();
  }, [chunkId]);

  if (!source) return null;
  const showPdf = pdfFor === source.chunkId;
  const pages =
    source.pageStart === source.pageEnd
      ? `p. ${source.pageStart}`
      : `pp. ${source.pageStart}–${source.pageEnd}`;
  return (
    <aside
      role={sheet ? 'dialog' : undefined}
      aria-modal={sheet ? false : undefined}
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      className="space-y-3 rounded-lg border p-4 text-sm dark:border-zinc-800"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={headingId} ref={heading} tabIndex={-1} className="font-semibold">
            {source.documentTitle}
          </h2>
          <p className="text-zinc-500">
            {source.insurer} · clause {source.clauseId} · {pages}
          </p>
          {source.sectionPath.length > 0 && (
            <p className="mt-1 text-xs text-zinc-500">
              {[...source.sectionPath, source.clauseId].join(' › ')}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded px-3 py-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          ×
        </button>
      </div>
      <p className="whitespace-pre-wrap leading-relaxed">{source.content}</p>
      <button
        type="button"
        onClick={() => setPdfFor(showPdf ? null : source.chunkId)}
        className="rounded border px-3 py-1.5 dark:border-zinc-700"
      >
        {showPdf ? 'Hide PDF' : `Open PDF at page ${source.pageStart}`}
      </button>
      {showPdf && (
        <PdfViewer
          key={source.chunkId}
          documentId={source.documentId}
          pageStart={source.pageStart}
          pageEnd={source.pageEnd}
          passage={source.content}
        />
      )}
    </aside>
  );
}
