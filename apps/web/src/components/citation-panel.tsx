'use client';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { SourceRef } from '@/lib/types';

// pdf.js touches the DOM (and a web worker) at import time, so the viewer is client-only.
const PdfViewer = dynamic(() => import('./pdf-viewer'), {
  ssr: false,
  loading: () => <p className="text-sm text-zinc-500">Loading viewer…</p>,
});

export function CitationPanel({
  source,
  onClose,
}: {
  source: SourceRef | null;
  onClose: () => void;
}) {
  const [showPdf, setShowPdf] = useState(false);
  if (!source) return null;
  const pages =
    source.pageStart === source.pageEnd
      ? `p. ${source.pageStart}`
      : `pp. ${source.pageStart}–${source.pageEnd}`;
  return (
    <aside
      aria-label="Cited clause"
      className="space-y-3 rounded-lg border p-4 text-sm dark:border-zinc-800"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{source.documentTitle}</p>
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
          className="rounded px-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          ×
        </button>
      </div>
      <p className="whitespace-pre-wrap leading-relaxed">{source.content}</p>
      <button
        type="button"
        onClick={() => setShowPdf((v) => !v)}
        className="rounded border px-3 py-1.5 dark:border-zinc-700"
      >
        {showPdf ? 'Hide PDF' : `Open PDF at page ${source.pageStart}`}
      </button>
      {showPdf && (
        <PdfViewer
          key={source.chunkId}
          documentId={source.documentId}
          page={source.pageStart}
          passage={source.content}
        />
      )}
    </aside>
  );
}
