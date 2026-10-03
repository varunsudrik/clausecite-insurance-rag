import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PublicDocument, SourceRef } from '@/lib/types';
import { ChatView } from './chat-view';

const doc = (
  id: string,
  title: string,
  status: PublicDocument['status'] = 'ready',
): PublicDocument => ({
  id,
  slug: id,
  title,
  insurer: 'Insurer',
  product: 'P',
  policyType: 'health',
  status,
  error: null,
  pageCount: 10,
  chunkCount: 20,
  embeddingModel: 'm',
  attempts: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const source: SourceRef = {
  n: 1,
  chunkId: 'c1',
  documentId: 'a',
  slug: 'a',
  documentTitle: 'Alpha Policy',
  insurer: 'Insurer',
  clauseId: 'C.3',
  clauseIds: ['C.3'],
  sectionPath: ['Waiting periods'],
  pageStart: 3,
  pageEnd: 3,
  content: 'Cataract surgery is covered after 24 months.',
  rerankScore: 0.9,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One complete UI-message-stream (SSE) answer that cites source 1 and carries a conversation id. */
function chatStream(conversationId = 'conv-1') {
  const chunks = [
    { type: 'start', messageId: 'srv-1' },
    { type: 'data-sources', data: { conversationId, question: 'q', sources: [source] } },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'Covered after 24 months [1] and [9].' },
    { type: 'text-end', id: 't' },
    {
      type: 'data-meta',
      data: {
        messageId: 'srv-1',
        conversationId,
        status: 'complete',
        answer: 'Covered after 24 months [1].',
        citations: [
          { n: 1, chunkId: 'c1', documentId: 'a', clauseId: 'C.3', pageStart: 3, pageEnd: 3 },
        ],
        uncited: false,
        usage: null,
        latencyMs: {},
        rerankDegraded: false,
        suggestions: [],
      },
    },
    { type: 'finish' },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

function setup(chat: () => Response | Promise<Response> = () => chatStream()) {
  localStorage.setItem(
    'clausecite.session',
    JSON.stringify({
      token: 'tok',
      role: 'guest',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
  );
  const chatBodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/documents')) {
      return json(200, [
        doc('a', 'Alpha Policy'),
        doc('b', 'Beta Policy'),
        doc('f', 'Broken', 'failed'),
      ]);
    }
    if (url.endsWith('/chat')) {
      chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chat();
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { chatBodies, fetchMock, user: userEvent.setup() };
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole('textbox'), text);
  await user.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('ChatView', () => {
  it('streams a cited answer, keeps the conversation id, and resets it on New chat', async () => {
    const { chatBodies, user } = setup();
    render(<ChatView />);
    await ask(user, 'Cataract waiting period?');

    expect(await screen.findByRole('button', { name: /source 1/i })).toBeInTheDocument();
    // The raw streamed "[9]" is gone once the cleaned meta answer replaces the deltas.
    await waitFor(() => expect(screen.queryByText(/\[9\]/)).toBeNull());
    expect(chatBodies[0]).toEqual({ message: 'Cataract waiting period?', mode: 'quick' });

    await ask(user, 'And for hernia?');
    await waitFor(() => expect(chatBodies).toHaveLength(2));
    expect(chatBodies[1]).toEqual({
      conversationId: 'conv-1',
      message: 'And for hernia?',
      mode: 'quick',
    });

    await user.click(screen.getByRole('button', { name: /new chat/i }));
    // useChat throttles its re-renders, so the cleared transcript lands a moment later.
    await waitFor(() => expect(screen.queryByRole('button', { name: /source 1/i })).toBeNull());
    await ask(user, 'Fresh start');
    await waitFor(() => expect(chatBodies).toHaveLength(3));
    expect(chatBodies[2]).not.toHaveProperty('conversationId');
  });

  it('sends the bearer token and scopes the question to the chosen ready policies', async () => {
    const { chatBodies, fetchMock, user } = setup();
    render(<ChatView />);
    await user.click(await screen.findByText(/all policies/i, { selector: 'summary' }));
    expect(screen.queryByLabelText(/broken/i)).toBeNull(); // only ready documents are offered
    await user.click(await screen.findByRole('checkbox', { name: /alpha policy/i }));
    await ask(user, 'q');
    await waitFor(() => expect(chatBodies).toHaveLength(1));
    expect(chatBodies[0]).toMatchObject({ documentIds: ['a'] });
    const chatCall = fetchMock.mock.calls.find(([url]) => url.endsWith('/chat'))!;
    expect(new Headers(chatCall[1]?.headers).get('authorization')).toBe('Bearer tok');
  });

  it('opens the cited clause text in the aside when a chip is clicked', async () => {
    const { user } = setup();
    render(<ChatView />);
    await ask(user, 'q');
    await user.click(await screen.findByRole('button', { name: /source 1/i }));
    const aside = screen.getByRole('complementary');
    expect(
      within(aside).getByText(/Cataract surgery is covered after 24 months/),
    ).toBeInTheDocument();
    expect(within(aside).getByText(/clause C\.3/)).toBeInTheDocument();
  });

  it('hands the selected source to onSelectSource instead of rendering its own aside', async () => {
    const { user } = setup();
    const onSelectSource = vi.fn();
    render(<ChatView onSelectSource={onSelectSource} />);
    await ask(user, 'q');
    await user.click(await screen.findByRole('button', { name: /source 1/i }));
    expect(onSelectSource).toHaveBeenCalledWith(expect.objectContaining({ clauseId: 'C.3' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('turns a 429 into a limit message with the wait time', async () => {
    const { user } = setup(() =>
      json(429, { statusCode: 429, message: 'Rate limit exceeded', retryAfterSeconds: 42 }),
    );
    render(<ChatView />);
    await ask(user, 'q');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You've hit the limit — try again in 42s",
    );
  });

  it('keeps the scope per request: narrowing to one policy, then back to all policies', async () => {
    const { chatBodies, user } = setup();
    render(<ChatView />);
    await user.click(await screen.findByText(/all policies/i, { selector: 'summary' }));
    await user.click(await screen.findByRole('checkbox', { name: /alpha policy/i }));
    await ask(user, 'first');
    await screen.findByRole('button', { name: /source 1/i });
    expect(chatBodies[0]).toMatchObject({ documentIds: ['a'] });

    await user.click(screen.getByRole('radio', { name: /all policies/i }));
    await ask(user, 'second');
    await waitFor(() => expect(chatBodies).toHaveLength(2));
    expect(chatBodies[1]).toEqual({ conversationId: 'conv-1', message: 'second', mode: 'quick' });
    expect(chatBodies[1]).not.toHaveProperty('documentIds');
  });

  it('puts the question back in the input and drops its bubble when the request is rejected', async () => {
    const { chatBodies, user } = setup(() =>
      json(429, { statusCode: 429, message: 'Rate limit exceeded', retryAfterSeconds: 42 }),
    );
    render(<ChatView />);
    await ask(user, 'What about cataract?');
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox')).toHaveValue('What about cataract?');
    await waitFor(() =>
      expect(screen.queryByText('What about cataract?', { selector: 'div' })).toBeNull(),
    );
    expect(chatBodies).toHaveLength(1);
  });

  it('restores the draft once per failure: clearing it afterwards sticks', async () => {
    const { user } = setup(() =>
      json(429, { statusCode: 429, message: 'Rate limit exceeded', retryAfterSeconds: 5 }),
    );
    render(<ChatView />);
    await ask(user, 'draft me');
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox')).toHaveValue('draft me');
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'z');
    expect(screen.getByRole('textbox')).toHaveValue('z');
  });

  it('shows the stream error text for a failed generation and lets the user retry it', async () => {
    let calls = 0;
    const { chatBodies, user } = setup(() =>
      ++calls === 1
        ? new Response(
            `data: ${JSON.stringify({ type: 'error', errorText: 'Something went wrong while generating the answer. Please retry.' })}\n\ndata: [DONE]\n\n`,
            {
              headers: {
                'content-type': 'text/event-stream',
                'x-vercel-ai-ui-message-stream': 'v1',
              },
            },
          )
        : chatStream(),
    );
    render(<ChatView />);
    await ask(user, 'retry me');
    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(screen.getByRole('textbox')).toHaveValue('retry me');

    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByRole('button', { name: /source 1/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(chatBodies.map((b) => b.message)).toEqual(['retry me', 'retry me']);
  });

  it('starts a new conversation after the API reports the old one as gone', async () => {
    let calls = 0;
    const { chatBodies, user } = setup(() =>
      ++calls === 2
        ? json(404, { statusCode: 404, message: 'conversation not found', error: 'Not Found' })
        : chatStream(`conv-${calls}`),
    );
    render(<ChatView />);
    await ask(user, 'one');
    await screen.findByRole('button', { name: /source 1/i });

    await ask(user, 'two');
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer available/i);
    expect(chatBodies[1]).toMatchObject({ conversationId: 'conv-1' });
    expect(screen.getByRole('textbox')).toHaveValue('two');

    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(chatBodies).toHaveLength(3));
    expect(chatBodies[2]).toEqual({ message: 'two', mode: 'quick' });
  });

  it('marks an answer that ended without its final meta as incomplete', async () => {
    const parts = [
      { type: 'start', messageId: 'srv-1' },
      {
        type: 'data-sources',
        data: { conversationId: 'conv-9', question: 'q', sources: [source] },
      },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Half an answer [1]' },
      { type: 'text-end', id: 't' },
      { type: 'finish' },
    ];
    const { user } = setup(
      () =>
        new Response(
          parts.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
          {
            headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
          },
        ),
    );
    render(<ChatView />);
    await ask(user, 'q');
    expect(await screen.findByText('incomplete')).toBeInTheDocument();
  });

  describe('focus', () => {
    /** An answer that stays open until `finish()`; lets a test act while the turn is in flight. */
    function openStream() {
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const send = (chunk: object | '[DONE]') =>
        controller.enqueue(
          encoder.encode(`data: ${chunk === '[DONE]' ? chunk : JSON.stringify(chunk)}\n\n`),
        );
      const response = new Response(
        new ReadableStream<Uint8Array>({ start: (c) => (controller = c) }),
        { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } },
      );
      const finish = () => {
        send({ type: 'start', messageId: 'srv-1' });
        send({
          type: 'data-sources',
          data: { conversationId: 'conv-1', question: 'q', sources: [source] },
        });
        send({ type: 'finish' });
        send('[DONE]');
        controller.close();
      };
      return { response, finish };
    }

    it('hands focus back to the input when a turn ends', async () => {
      const { response, finish } = openStream();
      const { user } = setup(() => response);
      render(<ChatView />);
      await ask(user, 'q');
      finish();
      await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
    });

    it('does not steal focus from something the user moved to during the turn', async () => {
      const { response, finish } = openStream();
      const { user } = setup(() => response);
      render(<ChatView />);
      await ask(user, 'q');
      const scope = screen.getByText(/all policies/i, { selector: 'summary' });
      await user.click(scope);
      expect(scope).toHaveFocus();
      finish();
      await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
      expect(scope).toHaveFocus();
    });
  });
});
