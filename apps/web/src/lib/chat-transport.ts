import { DefaultChatTransport } from 'ai';
import { API_URL } from './config';
import { clearSession, ensureSession, loadSession } from './session';
import type { ClauseCiteUIMessage } from './types';

export type ChatRequestState = { conversationId?: string; documentIds?: string[] };

/** The API only needs the new question: history lives server-side under the conversation id. */
export function buildChatRequestBody(messages: ClauseCiteUIMessage[], state: ChatRequestState) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const message = (last?.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();
  return {
    ...(state.conversationId ? { conversationId: state.conversationId } : {}),
    message,
    // An empty list matches nothing on the API, so "all policies" means the field is absent.
    ...(state.documentIds && state.documentIds.length > 0
      ? { documentIds: state.documentIds }
      : {}),
    mode: 'quick' as const,
  };
}

const bearer = (token: string) => `Bearer ${token}`;

/** Like apiFetch's 401 handling: drop the rejected token, mint a fresh one, retry the POST once. */
async function fetchWithRefresh(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 401) return res;
  const rejected = new Headers(init?.headers).get('authorization');
  const current = loadSession();
  if (current && bearer(current.token) === rejected) clearSession();
  const session = await ensureSession();
  const headers = new Headers(init?.headers);
  headers.set('authorization', bearer(session.token));
  return fetch(input, { ...init, headers });
}

export function createChatTransport(getState: () => ChatRequestState) {
  return new DefaultChatTransport<ClauseCiteUIMessage>({
    api: `${API_URL}/chat`,
    headers: async () => ({ Authorization: bearer((await ensureSession()).token) }),
    fetch: fetchWithRefresh,
    prepareSendMessagesRequest: ({ messages, headers }) => ({
      body: buildChatRequestBody(messages, getState()),
      headers,
    }),
  });
}
