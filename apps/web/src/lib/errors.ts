import { parseApiErrorMessage } from './api';
import { ApiError } from './http-error';

/** "42 s", "3 min", "2 h": a short wait for rate-limit messages. */
export function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.ceil(seconds))} s`;
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} min`;
  return `${Math.ceil(seconds / 3600)} h`;
}

/** What browsers throw for a failed fetch: "Failed to fetch" (Chrome), "NetworkError…" (Firefox), "Load failed" (Safari). */
const NETWORK_FAILURE = /fetch|network|load failed/i;

/** The `retryAfterSeconds` an error carries (an ApiError from a rate-limit answer), if it is a number. */
function waitOf(e: unknown): number | undefined {
  const seconds = (e as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  return typeof seconds === 'number' ? seconds : undefined;
}

/**
 * One user-facing string for anything the API client throws (ApiError, a network failure),
 * adding the wait time when the server said how long to back off.
 */
export function describeError(e: unknown): string {
  if (e instanceof TypeError && NETWORK_FAILURE.test(e.message)) {
    return 'Could not reach the server. Check your connection and retry.';
  }
  const message = e instanceof Error ? e.message : String(e);
  const seconds = waitOf(e);
  return seconds === undefined ? message : `${message}. Try again in ${formatWait(seconds)}.`;
}

/**
 * The banner text for a failed chat request. `useChat` keeps the thrown Error and nothing else of a
 * response: for a rejected POST that is the API's JSON body in `error.message` (429s carry
 * `retryAfterSeconds`), for a failed generation it is the stream's generic error text. An error thrown
 * before the POST (the transport's `ensureSession`, e.g. a rate-limited /auth/guest) is an ApiError
 * whose message is plain text and whose wait time is a property.
 */
export function describeChatError(error: Error): string {
  if (error instanceof TypeError) return describeError(error);
  if (error instanceof ApiError || waitOf(error) !== undefined) return describeError(error);
  if (isConversationGone(error)) {
    return 'This conversation is no longer available. Your next question starts a new chat.';
  }
  const { retryAfterSeconds, text } = parseApiErrorMessage(error.message);
  if (retryAfterSeconds === undefined) return text;
  const wait =
    retryAfterSeconds < 90
      ? `${Math.max(1, Math.ceil(retryAfterSeconds))}s`
      : formatWait(retryAfterSeconds);
  return `You've hit the limit — try again in ${wait}. (${text})`;
}

/** The API answered 404 "conversation not found" (e.g. the guest identity changed): the id is dead. */
export function isConversationGone(error: Error): boolean {
  const { status, text } = parseApiErrorMessage(error.message);
  return status === 404 && /conversation not found/i.test(text);
}
