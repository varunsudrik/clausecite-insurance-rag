import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, parseApiErrorMessage } from './api';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const future = () => new Date(Date.now() + 3600_000).toISOString();

describe('apiFetch', () => {
  it('sends the bearer token and parses JSON', async () => {
    localStorage.setItem(
      'clausecite.session',
      JSON.stringify({ token: 'tok', role: 'guest', expiresAt: future() }),
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(200, [{ id: 'd1' }]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/documents')).resolves.toEqual([{ id: 'd1' }]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('refreshes the guest token once on 401', async () => {
    localStorage.setItem(
      'clausecite.session',
      JSON.stringify({ token: 'stale', role: 'guest', expiresAt: future() }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { message: 'expired' }))
      .mockResolvedValueOnce(
        json(201, { token: 'fresh', user: { role: 'guest' }, expiresAt: future() }),
      )
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/auth/me')).resolves.toEqual({ ok: true });
    expect(
      new Headers((fetchMock.mock.calls[2][1] as RequestInit).headers).get('authorization'),
    ).toBe('Bearer fresh');
  });

  it('throws ApiError with retryAfterSeconds on 429', async () => {
    localStorage.setItem(
      'clausecite.session',
      JSON.stringify({ token: 'tok', role: 'guest', expiresAt: future() }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          429,
          { message: 'Rate limit exceeded', retryAfterSeconds: 42 },
          { 'retry-after': '42' },
        ),
      ),
    );
    const err = await apiFetch('/search', { method: 'POST', json: { query: 'x' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 429,
      retryAfterSeconds: 42,
      message: 'Rate limit exceeded',
    });
  });
});

describe('parseApiErrorMessage', () => {
  it('extracts message and retryAfterSeconds from a JSON error body', () => {
    expect(
      parseApiErrorMessage(
        '{"statusCode":429,"message":"Daily token budget exhausted","retryAfterSeconds":120}',
      ),
    ).toEqual({
      status: 429,
      retryAfterSeconds: 120,
      text: 'Daily token budget exhausted',
    });
    expect(parseApiErrorMessage('boom')).toEqual({ text: 'boom' });
  });
});
