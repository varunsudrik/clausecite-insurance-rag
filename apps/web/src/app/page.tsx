'use client';
import { useCallback, useState } from 'react';
import { ChatView } from '@/components/chat-view';
import { CitationPanel } from '@/components/citation-panel';
import type { SourceRef } from '@/lib/types';

export default function HomePage() {
  const [selected, setSelected] = useState<SourceRef | null>(null);
  const close = useCallback(() => setSelected(null), []);

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Ask your policy</h1>
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <ChatView onSelectSource={setSelected} onNewChat={close} />
        </div>
        {/* A sticky side column from lg up; on small screens a bottom sheet while a source is open. */}
        <div
          className={
            selected
              ? 'fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto border-t bg-white p-3 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 lg:static lg:inset-x-auto lg:bottom-auto lg:top-4 lg:z-auto lg:col-span-2 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:border-t-0 lg:p-0 lg:shadow-none lg:sticky'
              : 'hidden lg:col-span-2 lg:block'
          }
        >
          <CitationPanel source={selected} onClose={close} />
          {!selected && (
            <p className="rounded-lg border border-dashed p-4 text-sm text-zinc-500 dark:border-zinc-800">
              Select a citation number in an answer to read the clause here and open the policy PDF
              at the cited page.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
