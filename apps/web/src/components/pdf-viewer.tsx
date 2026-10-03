'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { API_URL } from '@/lib/config';
import { makeHighlighter } from '@/lib/highlight';
import { clearSession, ensureSession, loadSession } from '@/lib/session';

// Configured once per page load, when this client-only module is first imported.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

/** The page is never drawn wider than this, however much room the panel has. */
const MAX_PAGE_WIDTH = 800;
/** Used until the container has been measured. */
const DEFAULT_PAGE_WIDTH = 520;

const status = 'text-sm text-zinc-500';
const pageButton = 'rounded border px-2 py-0.5 disabled:opacity-40 dark:border-zinc-700';

/** Tracks the width of the element behind `ref`, so the page fits a narrow panel or a phone. */
function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export default function PdfViewer({
  documentId,
  page,
  passage,
}: {
  documentId: string;
  page: number;
  passage: string;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [noSession, setNoSession] = useState(false);
  const [numPages, setNumPages] = useState<number>();
  const [current, setCurrent] = useState(page);
  const [containerRef, width] = useContainerWidth();
  const refreshed = useRef(false);
  const highlighter = useMemo(() => makeHighlighter(passage), [passage]);
  // Stable identity: react-pdf redraws the text layer whenever the renderer changes.
  const renderText = useCallback(({ str }: { str: string }) => highlighter(str), [highlighter]);

  useEffect(() => {
    setCurrent(page);
  }, [page]);

  useEffect(() => {
    let live = true;
    ensureSession()
      .then((s) => live && setToken(s.token))
      .catch(() => live && setNoSession(true));
    return () => {
      live = false;
    };
  }, []);

  const file = useMemo(
    () =>
      token
        ? {
            url: `${API_URL}/documents/${documentId}/file`,
            httpHeaders: { Authorization: `Bearer ${token}` },
          }
        : null,
    [documentId, token],
  );

  const onLoadError = useCallback(
    (err: Error & { status?: number }) => {
      // Same rule as apiFetch: a rejected token is replaced with a fresh guest token, once. A new
      // `file` makes <Document> load again; its `error` content covers every other failure.
      if (err.status !== 401 || refreshed.current) return;
      refreshed.current = true;
      if (loadSession()?.token === token) clearSession();
      ensureSession()
        .then((s) => setToken(s.token))
        .catch(() => {});
    },
    [token],
  );

  // Never ask for a page the document does not have (a stale page range on a replaced PDF).
  const shown = numPages ? Math.min(Math.max(current, 1), numPages) : current;
  const unavailable = <p className="text-sm text-red-600">Could not load the PDF.</p>;

  return (
    <div ref={containerRef} className="space-y-2">
      {!file ? (
        noSession ? (
          unavailable
        ) : (
          <p className={status}>Loading PDF…</p>
        )
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              disabled={shown <= 1}
              onClick={() => setCurrent(shown - 1)}
              className={pageButton}
            >
              ‹ Prev
            </button>
            <span>
              Page {shown} {numPages ? `of ${numPages}` : ''}
            </span>
            <button
              type="button"
              disabled={!numPages || shown >= numPages}
              onClick={() => setCurrent(shown + 1)}
              className={pageButton}
            >
              Next ›
            </button>
          </div>
          <Document
            file={file}
            onLoadSuccess={({ numPages: n }) => setNumPages(n)}
            onLoadError={onLoadError}
            loading={<p className={status}>Loading PDF…</p>}
            error={unavailable}
          >
            <Page
              pageNumber={shown}
              width={Math.min(width || DEFAULT_PAGE_WIDTH, MAX_PAGE_WIDTH)}
              customTextRenderer={renderText}
            />
          </Document>
        </>
      )}
    </div>
  );
}
