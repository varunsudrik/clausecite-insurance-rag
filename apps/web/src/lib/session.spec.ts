import { describe, expect, it, vi } from 'vitest';
import { adminLogin, ensureSession, loadSession, logout } from './session';

const future = () => new Date(Date.now() + 3600_000).toISOString();
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('session', () => {
  it('obtains and stores a guest session once for concurrent callers', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      ok({ token: 't1', user: { id: 'u', role: 'guest' }, expiresAt: future() }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([ensureSession(), ensureSession()]);
    expect(a.token).toBe('t1');
    expect(b.token).toBe('t1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/auth/guest');
    expect(loadSession()?.role).toBe('guest');
  });

  it('ignores sessions that expire within a minute', () => {
    localStorage.setItem(
      'clausecite.session',
      JSON.stringify({
        token: 'x',
        role: 'guest',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    );
    expect(loadSession()).toBeNull();
  });

  it('admin login stores an admin session; logout clears it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok({ token: 'adm', user: { id: 'a', role: 'admin' }, expiresAt: future() }),
      ),
    );
    const s = await adminLogin('a@b.co', 'pw-pw-pw-pw-pw');
    expect(s).toMatchObject({ token: 'adm', role: 'admin' });
    logout();
    expect(loadSession()).toBeNull();
  });
});
