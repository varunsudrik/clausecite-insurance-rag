import { API_URL } from './config';

export type Session = { token: string; role: 'guest' | 'admin'; expiresAt: string };

/** A failed /auth/guest or /auth/login call; `retryAfterSeconds` is set on rate-limit (429) answers. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const KEY = 'clausecite.session';
const listeners = new Set<() => void>();
let inflight: Promise<Session> | null = null;

const notify = () => listeners.forEach((l) => l());

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (typeof s.token !== 'string' || (s.role !== 'guest' && s.role !== 'admin')) return null;
    return new Date(s.expiresAt).getTime() - Date.now() > 60_000 ? s : null;
  } catch {
    return null;
  }
}

function store(s: Session): Session {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: session lives for this page only */
  }
  notify();
  return s;
}

type IssuedToken = { token: string; user: { role: 'guest' | 'admin' }; expiresAt: string };

async function issue(path: string, body?: unknown): Promise<Session> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Partial<IssuedToken> & {
    message?: unknown;
    retryAfterSeconds?: unknown;
  };
  if (!res.ok || !data.token || !data.user || !data.expiresAt) {
    const header = Number(res.headers.get('retry-after'));
    const retryAfterSeconds =
      typeof data.retryAfterSeconds === 'number'
        ? data.retryAfterSeconds
        : Number.isFinite(header) && header > 0
          ? header
          : undefined;
    throw new AuthError(
      typeof data.message === 'string' ? data.message : `auth failed (${res.status})`,
      res.status,
      retryAfterSeconds,
    );
  }
  return store({ token: data.token, role: data.user.role, expiresAt: data.expiresAt });
}

export function ensureSession(): Promise<Session> {
  const existing = loadSession();
  if (existing) return Promise.resolve(existing);
  inflight ??= issue('/auth/guest').finally(() => {
    inflight = null;
  });
  return inflight;
}

export const adminLogin = (email: string, password: string) =>
  issue('/auth/login', { email, password });

export function logout(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  notify();
}

export function clearSession(): void {
  logout();
}

export function onSessionChange(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => e.key === KEY && cb();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}
