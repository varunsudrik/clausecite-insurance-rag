'use client';
import type { PublicDocument } from '@/lib/types';
import { StatusBadge } from './status-badge';

export function DocumentsTable({
  documents,
  isAdmin,
  onReingest,
  reingestingIds,
}: {
  documents: PublicDocument[];
  isAdmin: boolean;
  onReingest: (id: string) => void;
  /** Documents whose re-ingest request is still in flight; their button is disabled. */
  reingestingIds?: ReadonlySet<string>;
}) {
  if (documents.length === 0) {
    return <p className="text-sm text-zinc-500">No policies ingested yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-800">
          <tr>
            <th className="py-2 pr-4">Policy</th>
            <th className="py-2 pr-4">Insurer</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Pages</th>
            <th className="py-2 pr-4">Chunks</th>
            {isAdmin && (
              <th className="py-2">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {documents.map((d) => (
            <tr key={d.id} className="border-b border-zinc-100 align-top dark:border-zinc-900">
              <td className="py-2 pr-4 font-medium">{d.title}</td>
              <td className="py-2 pr-4">{d.insurer}</td>
              <td className="py-2 pr-4">
                <StatusBadge status={d.status} />
                {d.error && (
                  <div className="mt-1 font-mono text-xs text-red-600 dark:text-red-400">
                    {d.error}
                  </div>
                )}
              </td>
              <td className="py-2 pr-4">{d.pageCount ?? '—'}</td>
              <td className="py-2 pr-4">{d.chunkCount ?? '—'}</td>
              {isAdmin && (
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => onReingest(d.id)}
                    disabled={reingestingIds?.has(d.id)}
                    aria-label={`Re-ingest ${d.title}`}
                    className="rounded border px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    Re-ingest
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
