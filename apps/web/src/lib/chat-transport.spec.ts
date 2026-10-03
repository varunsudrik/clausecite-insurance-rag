import { describe, expect, it, vi } from 'vitest';
import { buildChatRequestBody, createChatTransport } from './chat-transport';
import type { ClauseCiteUIMessage } from './types';

const user = (id: string, text: string): ClauseCiteUIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

describe('buildChatRequestBody', () => {
  it('sends only the new message, conversation id, and non-empty scope', () => {
    const messages: ClauseCiteUIMessage[] = [
      user('m1', 'old'),
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
      user('m3', 'Is cataract covered?'),
    ];
    expect(buildChatRequestBody(messages, { conversationId: 'c1', documentIds: ['star'] })).toEqual(
      {
        conversationId: 'c1',
        message: 'Is cataract covered?',
        documentIds: ['star'],
        mode: 'quick',
      },
    );
  });

  it('omits documentIds when the scope is all policies or empty', () => {
    for (const documentIds of [undefined, []]) {
      const body = buildChatRequestBody([user('m', 'q')], { documentIds });
      expect(body).not.toHaveProperty('documentIds');
      expect(body).not.toHaveProperty('conversationId');
      expect(body).toEqual({ message: 'q', mode: 'quick' });
    }
  });

  it('trims the message text', () => {
    expect(buildChatRequestBody([user('m', '  hi  ')], {}).message).toBe('hi');
  });
});

describe('createChatTransport', () => {
  it('builds the request from the live state and the bearer token', async () => {
    const state: { conversationId?: string; documentIds?: string[] } = {};
    const transport = createChatTransport(() => state) as unknown as {
      prepareSendMessagesRequest: (o: unknown) => Promise<{ body: unknown }> | { body: unknown };
    };
    state.conversationId = 'c2';
    const req = await transport.prepareSendMessagesRequest({
      id: 'x',
      api: '/chat',
      body: undefined,
      credentials: undefined,
      headers: undefined,
      requestMetadata: undefined,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [user('m', 'q2')],
    });
    expect(req.body).toEqual({ conversationId: 'c2', message: 'q2', mode: 'quick' });
  });
});

describe('createChatTransport 401 handling', () => {
  const future = () => new Date(Date.now() + 3600_000).toISOString();
  const store = (token: string) =>
    localStorage.setItem(
      'clausecite.session',
      JSON.stringify({ token, role: 'guest', expiresAt: future() }),
    );

  it('replaces a rejected token with a fresh guest token and retries once', async () => {
    store('old');
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
        if (url.endsWith('/auth/guest')) {
          return new Response(
            JSON.stringify({ token: 'new', user: { role: 'guest' }, expiresAt: future() }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }
        return calls.filter((c) => c.url.endsWith('/chat')).length === 1
          ? new Response('{"message":"Unauthorized"}', { status: 401 })
          : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      }),
    );
    const transport = createChatTransport(() => ({}));
    await transport.sendMessages({
      chatId: 'x',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [user('m', 'hi')],
      abortSignal: undefined,
    });
    expect(calls.filter((c) => c.url.endsWith('/chat')).map((c) => c.auth)).toEqual([
      'Bearer old',
      'Bearer new',
    ]);
  });
});
