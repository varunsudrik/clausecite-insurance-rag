'use client';
import { useChat } from '@ai-sdk/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { createChatTransport, type ChatRequestState } from '@/lib/chat-transport';
import { describeChatError, isConversationGone } from '@/lib/errors';
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
  const formRef = useRef<HTMLFormElement>(null);
  /** The last question sent, so a failed send can put it back in the input. */
  const lastQuestion = useRef('');
  // Latest parent callback, read at click time so `cite` keeps one identity (AssistantMessage is memoized).
  const selectSource = useRef(onSelectSource);
  useEffect(() => {
    selectSource.current = onSelectSource;
  }, [onSelectSource]);

  const transport = useMemo(() => createChatTransport(() => state.current), []);
  const { messages, sendMessage, status, error, stop, setMessages, clearError } =
    useChat<ClauseCiteUIMessage>({
      transport,
      // Re-render at most every 50 ms while tokens stream in.
      throttle: 50,
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

  // A turn that failed was not answered: undo it so the user can fix the cause and send it again.
  useEffect(() => {
    if (!error) return;
    // The server forgot this conversation (e.g. the guest identity changed): start a fresh one next.
    if (isConversationGone(error)) state.current.conversationId = undefined;
    setInput((current) => current || lastQuestion.current);
    // Rejected before any answer started: the question is back in the input, so drop its bubble.
    setMessages((all) => (all.at(-1)?.role === 'user' ? all.slice(0, -1) : all));
  }, [error, setMessages]);

  // The disabled input drops focus while an answer is generated; hand it back when the turn ends,
  // unless the user moved on to something else (a citation chip, the scope menu). The form's own
  // Ask/Stop button counts as "still here": it is the same DOM node across the turn.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const active = document.activeElement;
      if (!active || active === document.body || formRef.current?.contains(active)) {
        inputRef.current?.focus();
      }
    }
    wasBusy.current = busy;
  }, [busy]);

  const cite = useCallback((s: SourceRef) => {
    if (selectSource.current) selectSource.current(s);
    else setSelected(s);
  }, []);
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
  const last = messages.at(-1);
  const searching = busy && !hasContent(last);

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
            <AssistantMessage
              key={m.id}
              message={m}
              onCite={cite}
              streaming={busy && m.id === last?.id}
            />
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
        ref={formRef}
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = input.trim();
          if (!text || busy) return;
          clearError();
          lastQuestion.current = text;
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
