'use client';
import { useCallback, useRef, useState } from 'react';
import { ChatView } from '@/components/chat-view';
import { CitationPanel } from '@/components/citation-panel';
import { useMediaQuery } from '@/lib/use-media-query';
import type { SourceRef } from '@/lib/types';

export default function HomePage() {
  const [selected, setSelected] = useState<SourceRef | null>(null);
  // Below lg (Tailwind's breakpoint) the panel is a bottom sheet over the chat, not a side column.
  const sheet = !useMediaQuery('(min-width: 1024px)');
  /** The chip (or button) that opened the panel, so closing it can hand focus back. */
  const opener = useRef<HTMLElement | null>(null);

  const select = useCallback((s: SourceRef) => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setSelected(s);
  }, []);
  const close = useCallback(() => {
    setSelected(null);
    opener.current?.focus();
    opener.current = null;
  }, []);
  // A new chat discards the chips; focus stays on the "New chat" button that was just pressed.
  const dismiss = useCallback(() => {
    setSelected(null);
    opener.current = null;
  }, []);

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Ask your policy</h1>
      <div className="grid gap-6 lg:grid-cols-5">
        {/* While the sheet covers the bottom of the screen, leave room to scroll the composer above it. */}
        <div className={`min-w-0 lg:col-span-3 ${selected ? 'max-lg:pb-[70vh]' : ''}`}>
          <ChatView onSelectSource={select} onNewChat={dismiss} />
        </div>
        {/* A sticky side column from lg up; on small screens a bottom sheet while a source is open. */}
        <div
          className={
            selected
              ? 'fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto border-t bg-white p-3 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 lg:inset-x-auto lg:bottom-auto lg:top-4 lg:z-auto lg:col-span-2 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:border-t-0 lg:p-0 lg:shadow-none lg:sticky'
              : 'hidden lg:col-span-2 lg:block'
          }
        >
          <CitationPanel source={selected} onClose={close} sheet={sheet} />
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
