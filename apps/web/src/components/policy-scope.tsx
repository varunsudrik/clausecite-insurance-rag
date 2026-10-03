'use client';
import { useEffect, useRef } from 'react';
import type { PublicDocument } from '@/lib/types';

/**
 * Which policies a question is asked against: `undefined` is "All policies" (the API gets no
 * `documentIds`); otherwise a non-empty subset of the ready documents.
 */
export function PolicyScope({
  documents,
  unavailable = false,
  value,
  onChange,
}: {
  /** Only documents that can be searched (status "ready"). */
  documents: PublicDocument[];
  /** The list could not be loaded: say so instead of claiming there are no ready policies. */
  unavailable?: boolean;
  value: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  // A <details> stays open until its summary is clicked again; close it like a menu instead.
  useEffect(() => {
    const dismiss = (e: Event) => {
      const el = menu.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node)) {
        el.open = false;
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, []);

  const selected = new Set(value);
  const count = documents.filter((d) => selected.has(d.id)).length;
  const summary =
    value === undefined || count === 0
      ? 'All policies'
      : `${count} ${count === 1 ? 'policy' : 'policies'}`;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const ids = documents.filter((d) => next.has(d.id)).map((d) => d.id);
    // Nothing picked, or everything picked one by one, both mean "no restriction".
    onChange(ids.length === 0 || ids.length === documents.length ? undefined : ids);
  }

  return (
    <details ref={menu} className="relative">
      <summary className="cursor-pointer select-none rounded border px-3 py-1.5 text-sm dark:border-zinc-700">
        <span className="text-zinc-500">Scope: </span>
        {summary}
      </summary>
      <fieldset className="absolute left-0 z-10 mt-1 min-w-64 space-y-1 rounded-md border bg-white p-3 text-sm shadow-md dark:border-zinc-700 dark:bg-zinc-900">
        <legend className="sr-only">Policies to search</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="policy-scope"
            checked={value === undefined}
            onChange={() => onChange(undefined)}
          />
          All policies
        </label>
        {documents.map((d) => (
          <label key={d.id} className="flex items-center gap-2">
            <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
            <span>
              {d.title} <span className="text-xs text-zinc-500">{d.insurer}</span>
            </span>
          </label>
        ))}
        {unavailable ? (
          <p className="text-xs text-red-600 dark:text-red-400">Policies could not be loaded.</p>
        ) : (
          documents.length === 0 && <p className="text-xs text-zinc-500">No ready policies yet.</p>
        )}
      </fieldset>
    </details>
  );
}
