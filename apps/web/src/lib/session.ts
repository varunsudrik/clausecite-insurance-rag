import { API_URL } from './config';
import { errorFromResponse } from './http-error';

export type Session = { token: string; role: 'guest' | 'admin'; expiresAt: string };

const KEY = 'clausecite.session';
const listeners = new Set<() => void>();
let inflight: Promise<Session> | null = null;
/** Bumped whenever an admin session is stored; lets a slow guest request notice it lost the race. */
let adminEpoch = 0;
/**
 * The session the browser refused to keep (storage blocked, private mode, quota). Only set when
 * persisting failed, so a cleared or replaced storage entry (logout in another tab) still wins.
 */
let memory: Session | null = null;

const notify = () => listeners.forEach((l) => l());

/** A well-formed session that stays valid for more than another minute. */
function usable(s: unknown): s is Session {
  if (!s || typeof s !== 'object') return false;
  const { token, role, expiresAt } = s as Partial<Session>;
  if (typeof token !== 'string' || (role !== 'guest' && role !== 'admin')) return false;
  return new Date(String(expiresAt)).getTime() - Date.now() > 60_000;
}

function readStored(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return usable(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadSession(): Session | null {
  return readStored() ?? (usable(memory) ? memory : null);
}

function store(s: Session): Session {
  if (s.role === 'admin') adminEpoch++;
  let persisted = false;
  try {
    const json = JSON.stringify(s);
    localStorage.setItem(KEY, json);
    persisted = localStorage.getItem(KEY) === json;
  } catch {
    /* storage unavailable: fall back to memory below */
  }
  memory = persisted ? null : s;
  if (!persisted) {
    try {
      localStorage.removeItem(KEY); // never let an older stored session shadow the new in-memory one
    } catch {
      /* ignore */
    }
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
  const data = (await res.json().catch(() => null)) as Partial<IssuedToken> | null;
  if (!res.ok || !data?.token || !data.user || !data.expiresAt) {
    throw errorFromResponse(res, data, `auth failed (${res.status})`);
  }
  return { token: data.token, role: data.user.role, expiresAt: data.expiresAt };
}

async function issueGuest(): Promise<Session> {
  const epoch = adminEpoch;
  const guest = await issue('/auth/guest');
  if (adminEpoch !== epoch) {
    // An admin logged in while this request was in flight: keep the admin session, not the guest one.
    const current = loadSession();
    if (current) return current;
  }
  return store(guest);
}

export function ensureSession(): Promise<Session> {
  const existing = loadSession();
  if (existing) return Promise.resolve(existing);
  inflight ??= issueGuest().finally(() => {
    inflight = null;
  });
  return inflight;
}

export const adminLogin = async (email: string, password: string) =>
  store(await issue('/auth/login', { email, password }));

export function logout(): void {
  memory = null;
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
  // key === null is storage.clear() in another tab.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}
