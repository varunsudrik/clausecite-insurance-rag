import { API_URL } from './config';
import { ApiError, errorFromResponse, messageOf } from './http-error';
import { clearSession, ensureSession, loadSession } from './session';

export { ApiError };

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
  let session = await ensureSession();
  let res = await doFetch(path, init, session.token);
  if (res.status === 401) {
    // Drop only the session that was actually rejected: another request may already have replaced it
    // (a fresh guest token, an admin login), and a late 401 must not wipe that newer one.
    if (loadSession()?.token === session.token) clearSession();
    session = await ensureSession();
    res = await doFetch(path, init, session.token);
  }
  const body = parseBody(await res.text());
  if (!res.ok) throw errorFromResponse(res, body);
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
