/** A non-2xx answer from the API (including /auth/*); `retryAfterSeconds` is set on rate-limit answers. */
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

/** The human-readable `message` of a Nest error body (string or validation-array), else `fallback`. */
export function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.join(', ');
  }
  return fallback;
}

/** Seconds to back off: the body's `retryAfterSeconds`, else a positive numeric `Retry-After` header. */
export function retryAfterOf(body: unknown, headers: Headers): number | undefined {
  if (body && typeof body === 'object') {
    const seconds = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof seconds === 'number') return seconds;
  }
  const header = Number(headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? header : undefined;
}

export function errorFromResponse(
  res: Response,
  body: unknown,
  fallback = `request failed (${res.status})`,
): ApiError {
  return new ApiError(messageOf(body, fallback), res.status, body, retryAfterOf(body, res.headers));
}
