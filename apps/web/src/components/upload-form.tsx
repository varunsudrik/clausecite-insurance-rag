'use client';
import { useState, type FormEvent } from 'react';
import { apiFetch } from '@/lib/api';
import { describeError } from '@/lib/errors';
import type { PublicDocument } from '@/lib/types';

type Notice = { kind: 'ok' | 'error'; text: string };

const inputClass =
  'w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700';

export function UploadForm({ onUploaded }: { onUploaded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setNotice(null);
    try {
      // No content-type header: the browser sets the multipart boundary itself.
      const doc = await apiFetch<PublicDocument & { deduplicated?: boolean }>('/documents', {
        method: 'POST',
        body: new FormData(form),
      });
      setNotice({
        kind: 'ok',
        text: doc.deduplicated ? 'Already ingested (deduplicated)' : 'Uploaded — ingesting…',
      });
      form.reset();
      onUploaded();
    } catch (err) {
      setNotice({ kind: 'error', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <h2 className="text-base font-semibold">Upload a policy</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-zinc-600 dark:text-zinc-400">PDF file</span>
          <input
            name="file"
            type="file"
            accept="application/pdf"
            required
            className="block w-full text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Slug</span>
          <input
            name="slug"
            required
            pattern="[a-z0-9\-]{3,80}"
            title="3-80 characters: lowercase letters, digits and hyphens"
            placeholder="star-health-comprehensive"
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Title</span>
          <input name="title" required maxLength={200} className={inputClass} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Insurer</span>
          <input name="insurer" required maxLength={200} className={inputClass} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Product</span>
          <input name="product" required maxLength={200} className={inputClass} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Policy type</span>
          <input
            name="policy_type"
            required
            maxLength={50}
            defaultValue="health"
            className={inputClass}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? 'Uploading…' : 'Upload'}
        </button>
        {notice && (
          <p
            role={notice.kind === 'error' ? 'alert' : 'status'}
            className={
              notice.kind === 'error'
                ? 'text-sm text-red-600 dark:text-red-400'
                : 'text-sm text-emerald-700 dark:text-emerald-400'
            }
          >
            {notice.text}
          </p>
        )}
      </div>
    </form>
  );
}
