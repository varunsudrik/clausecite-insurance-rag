export type IngestErrorCode =
  | 'DOCUMENT_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'PDF_PARSE_FAILED'
  | 'NO_TEXT_LAYER'
  | 'TOO_MANY_PAGES'
  | 'EMBEDDING_FAILED'
  | 'EMBEDDING_INVALID'
  | 'CHUNK_DATA_INVALID';

const RETRYABLE: ReadonlySet<IngestErrorCode> = new Set(['EMBEDDING_FAILED']);

export class IngestError extends Error {
  override name = 'IngestError';
  constructor(
    readonly code: IngestErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

/** Unknown errors (DB blips, network) are retried; classified ingest errors decide for themselves. */
export function isRetryable(err: unknown): boolean {
  return err instanceof IngestError ? err.retryable : true;
}

/** The SQLSTATE of a node-postgres error, which drizzle wraps in a DrizzleQueryError's `cause`. */
function sqlState(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  for (
    let e = err;
    typeof e === 'object' && e !== null && !seen.has(e);
    e = (e as { cause?: unknown }).cause
  ) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/**
 * Database data exceptions (SQLSTATE class 22: invalid byte sequence, string too long, bad vector
 * input...) are deterministic: the same chunks fail the same way every time, so retrying only burns
 * embedding calls. They become the non-retryable CHUNK_DATA_INVALID; everything else (connection
 * blips, serialization failures, ingest errors) is returned unchanged.
 */
export function classifyDbError(err: unknown): unknown {
  if (err instanceof IngestError) return err;
  const state = sqlState(err);
  if (state?.startsWith('22')) {
    return new IngestError(
      'CHUNK_DATA_INVALID',
      `the database rejected the extracted chunk data (SQLSTATE ${state})`,
      { cause: err },
    );
  }
  return err;
}
