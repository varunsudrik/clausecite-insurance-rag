'use client';
import { useCallback, useEffect, useState } from 'react';
import { DocumentsTable } from '@/components/documents-table';
import { UploadForm } from '@/components/upload-form';
import { apiFetch } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { ensureSession } from '@/lib/session';
import type { PublicDocument } from '@/lib/types';
import { useSessionRole } from '@/lib/use-session-role';

const POLL_MS = 5000;

export default function DocumentsPage() {
  const isAdmin = useSessionRole() === 'admin';
  const [documents, setDocuments] = useState<PublicDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setDocuments(await apiFetch<PublicDocument[]>('/documents'));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    ensureSession().then(reload, (e) => setError(describeError(e)));
  }, [reload]);

  // Poll only while something is still being ingested; the interval is cleared on unmount.
  const ingesting = documents?.some((d) => d.status === 'queued' || d.status === 'processing');
  useEffect(() => {
    if (!ingesting) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [ingesting, reload]);

  const reingest = (id: string) =>
    apiFetch(`/documents/${id}/reingest`, { method: 'POST' }).then(reload, (e) =>
      setError(describeError(e)),
    );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Policies</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          The policy wordings ClauseCite can answer from.
        </p>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </div>
      )}
      {documents === null ? (
        !error && <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <DocumentsTable documents={documents} isAdmin={isAdmin} onReingest={reingest} />
      )}
      {isAdmin && <UploadForm onUploaded={reload} />}
    </div>
  );
}
