import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, parseApiErrorMessage } from './api';
import { loadSession, logout } from './session';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const future = () => new Date(Date.now() + 3600_000).toISOString();
const storeSession = (token: string, role: 'guest' | 'admin' = 'guest') =>
  localStorage.setItem('clausecite.session', JSON.stringify({ token, role, expiresAt: future() }));
const bearer = (call: unknown[]) =>
  new Headers((call[1] as RequestInit).headers).get('authorization');

describe('apiFetch', () => {
  it('sends the bearer token and parses JSON', async () => {
    storeSession('tok');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(200, [{ id: 'd1' }]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/documents')).resolves.toEqual([{ id: 'd1' }]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('refreshes the guest token once on 401', async () => {
    storeSession('stale');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { message: 'expired' }))
      .mockResolvedValueOnce(
        json(201, { token: 'fresh', user: { role: 'guest' }, expiresAt: future() }),
      )
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/auth/me')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bearer(fetchMock.mock.calls[0])).toBe('Bearer stale');
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://localhost:3001/auth/guest');
    expect(bearer(fetchMock.mock.calls[2])).toBe('Bearer fresh');
  });

  it('gives up after one refresh: a second 401 is thrown, not retried', async () => {
    storeSession('stale');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { message: 'expired' }))
      .mockResolvedValueOnce(
        json(201, { token: 'fresh', user: { role: 'guest' }, expiresAt: future() }),
      )
      .mockResolvedValueOnce(json(401, { message: 'still no' }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await apiFetch('/auth/me').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: 'still no' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not wipe a newer session when a late 401 arrives for an older token', async () => {
    storeSession('old');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (new Headers(init?.headers).get('authorization') === 'Bearer old') {
        storeSession('newer', 'admin'); // another request replaced the session meanwhile
        return json(401, { message: 'expired' });
      }
      return json(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/documents')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2); // no new guest token was minted
    expect(bearer(fetchMock.mock.calls[1])).toBe('Bearer newer');
    expect(loadSession()).toMatchObject({ token: 'newer', role: 'admin' });
  });

  it('throws ApiError with retryAfterSeconds on 429', async () => {
    storeSession('tok');
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

  it('falls back to the Retry-After header when the body has no seconds', async () => {
    storeSession('tok');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(429, { message: 'Rate limit exceeded' }, { 'retry-after': '90' })),
    );
    await expect(apiFetch('/search')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 90 });
  });

  it('mints exactly one guest token across calls when localStorage is unavailable', async () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
      clear: () => {},
    };
    vi.stubGlobal('localStorage', broken);
    try {
      const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
        url.endsWith('/auth/guest')
          ? json(201, { token: 'mem', user: { role: 'guest' }, expiresAt: future() })
          : json(200, []),
      );
      vi.stubGlobal('fetch', fetchMock);
      await apiFetch('/documents');
      await apiFetch('/documents');
      const mints = fetchMock.mock.calls.filter(([url]) => url.endsWith('/auth/guest'));
      expect(mints).toHaveLength(1);
      expect(bearer(fetchMock.mock.calls[2])).toBe('Bearer mem');
    } finally {
      logout();
    }
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
