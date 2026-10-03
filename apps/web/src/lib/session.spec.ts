import { describe, expect, it, vi } from 'vitest';
import { adminLogin, ensureSession, loadSession, logout, onSessionChange } from './session';

const future = () => new Date(Date.now() + 3600_000).toISOString();
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const guestBody = (token: string) => ({
  token,
  user: { id: 'u', role: 'guest' },
  expiresAt: future(),
});
const adminBody = (token: string) => ({
  token,
  user: { id: 'a', role: 'admin' },
  expiresAt: future(),
});

/** A localStorage that refuses everything (Safari private mode, blocked site data, quota). */
const brokenStorage = {
  getItem: () => {
    throw new Error('storage denied');
  },
  setItem: () => {
    throw new Error('storage denied');
  },
  removeItem: () => {
    throw new Error('storage denied');
  },
  clear: () => {},
};

describe('session', () => {
  it('obtains and stores a guest session once for concurrent callers', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ok(guestBody('t1')));
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
      vi.fn(async () => ok(adminBody('adm'))),
    );
    const s = await adminLogin('a@b.co', 'pw-pw-pw-pw-pw');
    expect(s).toMatchObject({ token: 'adm', role: 'admin' });
    logout();
    expect(loadSession()).toBeNull();
  });
});

describe('session without usable localStorage', () => {
  it('keeps an admin login in memory until logout', async () => {
    vi.stubGlobal('localStorage', brokenStorage);
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(adminBody('adm'))),
      );
      await adminLogin('a@b.co', 'pw-pw-pw-pw-pw');
      expect(loadSession()).toMatchObject({ token: 'adm', role: 'admin' });
      logout();
      expect(loadSession()).toBeNull();
    } finally {
      logout();
    }
  });

  it('applies the one-minute expiry rule to the in-memory session too', async () => {
    vi.stubGlobal('localStorage', brokenStorage);
    try {
      const soon = { ...adminBody('adm'), expiresAt: new Date(Date.now() + 30_000).toISOString() };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(soon)),
      );
      await adminLogin('a@b.co', 'pw-pw-pw-pw-pw');
      expect(loadSession()).toBeNull();
    } finally {
      logout();
    }
  });

  it('reuses the in-memory guest session instead of minting another', async () => {
    vi.stubGlobal('localStorage', brokenStorage);
    try {
      const fetchMock = vi.fn(async () => ok(guestBody('g1')));
      vi.stubGlobal('fetch', fetchMock);
      await ensureSession();
      await ensureSession();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      logout();
    }
  });
});

describe('session races', () => {
  it('does not let a late guest response overwrite an admin login', async () => {
    let releaseGuest!: (r: Response) => void;
    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      url.endsWith('/auth/guest')
        ? new Promise<Response>((resolve) => (releaseGuest = resolve))
        : Promise.resolve(ok(adminBody('adm'))),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pendingGuest = ensureSession();
    await adminLogin('a@b.co', 'pw-pw-pw-pw-pw');
    releaseGuest(ok(guestBody('late-guest')));

    await expect(pendingGuest).resolves.toMatchObject({ token: 'adm', role: 'admin' });
    expect(loadSession()).toMatchObject({ token: 'adm', role: 'admin' });
  });

  it('still stores a guest session when the admin logged out before it arrived', async () => {
    let releaseGuest!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, _init?: RequestInit) =>
        url.endsWith('/auth/guest')
          ? new Promise<Response>((resolve) => (releaseGuest = resolve))
          : Promise.resolve(ok(adminBody('adm'))),
      ),
    );
    const pendingGuest = ensureSession();
    await adminLogin('a@b.co', 'pw-pw-pw-pw-pw');
    logout();
    releaseGuest(ok(guestBody('g2')));
    await expect(pendingGuest).resolves.toMatchObject({ token: 'g2', role: 'guest' });
    expect(loadSession()?.token).toBe('g2');
  });
});

describe('onSessionChange', () => {
  it('fires for in-tab changes and for storage events on the session key or a full clear', () => {
    const cb = vi.fn();
    const off = onSessionChange(cb);
    logout();
    expect(cb).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'clausecite.session' }));
    expect(cb).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent('storage', { key: null })); // storage.clear() in another tab
    expect(cb).toHaveBeenCalledTimes(3);
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
    expect(cb).toHaveBeenCalledTimes(3);
    off();
    logout();
    expect(cb).toHaveBeenCalledTimes(3);
  });
});
