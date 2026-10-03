import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterReranker, RerankError } from './rerank.js';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('createOpenRouterReranker', () => {
  it('posts query/documents/top_n and returns hits sorted by score', async () => {
    const fetchMock = vi.fn(async () =>
      ok({
        model: 'cohere/rerank-v3.5',
        results: [
          { index: 0, relevance_score: 0.1, document: { text: 'a' } },
          { index: 1, relevance_score: 0.9, document: { text: 'b' } },
        ],
      }),
    );
    const r = createOpenRouterReranker({
      apiKey: 'k',
      model: 'cohere/rerank-v3.5',
      fetch: fetchMock,
    });
    const hits = await r.rerank('q', ['a', 'b'], 2);
    expect(hits).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/rerank');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'cohere/rerank-v3.5',
      query: 'q',
      documents: ['a', 'b'],
      top_n: 2,
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('returns [] for no documents without calling the API', async () => {
    const fetchMock = vi.fn();
    const r = createOpenRouterReranker({ apiKey: 'k', model: 'm', fetch: fetchMock });
    expect(await r.rerank('q', [], 5)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws RerankError on HTTP errors and malformed bodies', async () => {
    const bad = createOpenRouterReranker({
      apiKey: 'k',
      model: 'm',
      fetch: vi.fn(async () => new Response('nope', { status: 502 })),
    });
    await expect(bad.rerank('q', ['a'], 1)).rejects.toBeInstanceOf(RerankError);
    const malformed = createOpenRouterReranker({
      apiKey: 'k',
      model: 'm',
      fetch: vi.fn(async () => ok({ data: [] })),
    });
    await expect(malformed.rerank('q', ['a'], 1)).rejects.toBeInstanceOf(RerankError);
  });

  it('throws RerankError on timeout', async () => {
    const slow = createOpenRouterReranker({
      apiKey: 'k',
      model: 'm',
      timeoutMs: 20,
      fetch: (_u, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    });
    await expect(slow.rerank('q', ['a'], 1)).rejects.toBeInstanceOf(RerankError);
  });
});
