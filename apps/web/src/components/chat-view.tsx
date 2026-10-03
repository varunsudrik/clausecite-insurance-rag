'use client';
import { useChat } from '@ai-sdk/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { createChatTransport, type ChatRequestState } from '@/lib/chat-transport';
import { describeChatError } from '@/lib/errors';
import { ensureSession } from '@/lib/session';
import type { ClauseCiteUIMessage, PublicDocument, SourceRef } from '@/lib/types';
import { AssistantMessage } from './assistant-message';
import { PolicyScope } from './policy-scope';

/** True once an assistant message shows something: streamed text or the final meta. */
const hasContent = (m: ClauseCiteUIMessage | undefined) =>
  m?.role === 'assistant' &&
  m.parts.some((p) => (p.type === 'text' && p.text !== '') || p.type === 'data-meta');

export function ChatView({ onSelectSource }: { onSelectSource?: (s: SourceRef) => void }) {
  const [documents, setDocuments] = useState<PublicDocument[]>([]);
  const [scope, setScope] = useState<string[] | undefined>();
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState<SourceRef | null>(null);
  // Read by the transport at send time, so the scope and conversation always reflect the latest UI state.
  const state = useRef<ChatRequestState>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const transport = useMemo(() => createChatTransport(() => state.current), []);
  const { messages, sendMessage, status, error, stop, setMessages, clearError } =
    useChat<ClauseCiteUIMessage>({
      transport,
      onData: (part) => {
        if (part.type === 'data-sources') state.current.conversationId = part.data.conversationId;
      },
    });

  useEffect(() => {
    let live = true;
    ensureSession()
      .then(() => apiFetch<PublicDocument[]>('/documents'))
      .then((docs) => live && setDocuments(docs))
      .catch(() => live && setDocuments([]));
    return () => {
      live = false;
    };
  }, []);

  const busy = status === 'submitted' || status === 'streaming';
  // The disabled input drops focus while an answer is generated; hand it back when the turn ends.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) inputRef.current?.focus();
    wasBusy.current = busy;
  }, [busy]);

  const cite = (s: SourceRef) => (onSelectSource ? onSelectSource(s) : setSelected(s));
  const changeScope = (next: string[] | undefined) => {
    state.current.documentIds = next;
    setScope(next);
  };
  const newChat = () => {
    if (busy) void stop();
    setMessages([]);
    setSelected(null);
    state.current.conversationId = undefined;
    clearError();
  };
  const searching = busy && !hasContent(messages.at(-1));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <PolicyScope
          documents={documents.filter((d) => d.status === 'ready')}
          value={scope}
          onChange={changeScope}
        />
        <button
          type="button"
          onClick={newChat}
          className="rounded border px-3 py-1.5 text-sm dark:border-zinc-700"
        >
          New chat
        </button>
      </div>

      <div className="space-y-6">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">
            Ask about waiting periods, exclusions, room-rent limits or definitions — every answer
            cites the clause and page.
          </p>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div
              key={m.id}
              className="ml-auto max-w-[80%] rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900"
            >
              {m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}
            </div>
          ) : (
            <AssistantMessage key={m.id} message={m} onCite={cite} />
          ),
        )}
        {searching && (
          <p role="status" className="text-sm text-zinc-500">
            Searching the policies…
          </p>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {describeChatError(error)}
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = input.trim();
          if (!text || busy) return;
          clearError();
          void sendMessage({ text });
          setInput('');
        }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Your question"
          placeholder="e.g. What is the waiting period for cataract surgery?"
          maxLength={2000}
          disabled={busy}
          className="flex-1 rounded-md border px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => void stop()}
            className="rounded-md border px-4 py-2 text-sm dark:border-zinc-700"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Ask
          </button>
        )}
      </form>

      {!onSelectSource && selected && (
        <aside className="rounded-md border p-3 text-sm dark:border-zinc-800">
          <p className="font-medium">
            {selected.documentTitle} — clause {selected.clauseId} (p. {selected.pageStart})
          </p>
          <p className="mt-2 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
            {selected.content}
          </p>
        </aside>
      )}
    </div>
  );
}
