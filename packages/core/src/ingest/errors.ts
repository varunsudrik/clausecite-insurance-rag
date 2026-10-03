export type IngestErrorCode =
  | 'DOCUMENT_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'PDF_PARSE_FAILED'
  | 'NO_TEXT_LAYER'
  | 'TOO_MANY_PAGES'
  | 'EMBEDDING_FAILED'
  | 'EMBEDDING_INVALID';

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
