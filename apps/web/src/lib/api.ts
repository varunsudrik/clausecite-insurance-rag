import { API_URL } from './config';
import { clearSession, ensureSession } from './session';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.join(', ');
  }
  return fallback;
}

async function doFetch(path: string, init: RequestInit & { json?: unknown }, token: string) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return fetch(`${API_URL}${path}`, { ...init, headers, body });
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  let res = await doFetch(path, init, (await ensureSession()).token);
  if (res.status === 401) {
    clearSession();
    res = await doFetch(path, init, (await ensureSession()).token);
  }
  const body = parseBody(await res.text());
  if (!res.ok) {
    const fromBody =
      body &&
      typeof body === 'object' &&
      typeof (body as { retryAfterSeconds?: unknown }).retryAfterSeconds === 'number'
        ? (body as { retryAfterSeconds: number }).retryAfterSeconds
        : undefined;
    const header = Number(res.headers.get('retry-after'));
    throw new ApiError(
      messageOf(body, `request failed (${res.status})`),
      res.status,
      body,
      fromBody ?? (Number.isFinite(header) && header > 0 ? header : undefined),
    );
  }
  return body as T;
}

export function parseApiErrorMessage(message: string): {
  status?: number;
  retryAfterSeconds?: number;
  text: string;
} {
  try {
    const body = JSON.parse(message) as {
      statusCode?: number;
      message?: unknown;
      retryAfterSeconds?: number;
    };
    return {
      ...(typeof body.statusCode === 'number' ? { status: body.statusCode } : {}),
      ...(typeof body.retryAfterSeconds === 'number'
        ? { retryAfterSeconds: body.retryAfterSeconds }
        : {}),
      text: messageOf(body, message),
    };
  } catch {
    return { text: message };
  }
}
