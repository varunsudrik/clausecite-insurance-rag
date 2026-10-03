import { parseApiErrorMessage } from './api';

/** "42 s", "3 min", "2 h": a short wait for rate-limit messages. */
export function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.ceil(seconds))} s`;
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} min`;
  return `${Math.ceil(seconds / 3600)} h`;
}

/** What browsers throw for a failed fetch: "Failed to fetch" (Chrome), "NetworkError…" (Firefox), "Load failed" (Safari). */
const NETWORK_FAILURE = /fetch|network|load failed/i;

/**
 * One user-facing string for anything the API client throws (ApiError, a network failure),
 * adding the wait time when the server said how long to back off.
 */
export function describeError(e: unknown): string {
  if (e instanceof TypeError && NETWORK_FAILURE.test(e.message)) {
    return 'Could not reach the server. Check your connection and retry.';
  }
  const message = e instanceof Error ? e.message : String(e);
  const seconds = (e as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  return typeof seconds === 'number' ? `${message}. Try again in ${formatWait(seconds)}.` : message;
}

/**
 * The banner text for a failed chat request. `useChat` only keeps `error.message`: for a rejected POST
 * that is the API's JSON body (429s carry `retryAfterSeconds`), for a failed generation it is the
 * stream's generic error text.
 */
export function describeChatError(error: Error): string {
  if (error instanceof TypeError) return describeError(error);
  const { retryAfterSeconds, text } = parseApiErrorMessage(error.message);
  if (retryAfterSeconds === undefined) return text;
  const wait =
    retryAfterSeconds < 90
      ? `${Math.max(1, Math.ceil(retryAfterSeconds))}s`
      : formatWait(retryAfterSeconds);
  return `You've hit the limit — try again in ${wait}. (${text})`;
}
