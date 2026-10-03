import { describe, expect, it } from 'vitest';
import { classifyDbError, IngestError, isRetryable } from './errors.js';

/** node-postgres reports `code`; drizzle 0.45 wraps it in a DrizzleQueryError whose `cause` is that error. */
const pgError = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });
const wrapped = (code: string) =>
  Object.assign(new Error('Failed query: insert into "chunks" ...'), { cause: pgError(code) });

describe('classifyDbError', () => {
  it.each(['22021', '22P05', '22001', '22P02'])(
    'maps SQLSTATE class 22 (%s, bare or wrapped by drizzle) to non-retryable CHUNK_DATA_INVALID',
    (code) => {
      for (const err of [pgError(code), wrapped(code)]) {
        const mapped = classifyDbError(err);
        expect(mapped).toBeInstanceOf(IngestError);
        expect(mapped).toMatchObject({ code: 'CHUNK_DATA_INVALID', retryable: false, cause: err });
        expect((mapped as IngestError).message).toContain(`SQLSTATE ${code}`);
        expect(isRetryable(mapped)).toBe(false);
      }
    },
  );

  it('leaves other database errors alone so they are still retried', () => {
    for (const err of [
      pgError('23505'), // unique_violation
      pgError('40001'), // serialization_failure
      pgError('57P01'), // admin_shutdown
      wrapped('08006'), // connection_failure
      new Error('ECONNRESET'),
      'a string',
      undefined,
    ]) {
      expect(classifyDbError(err)).toBe(err);
      expect(isRetryable(classifyDbError(err))).toBe(true);
    }
  });

  it('never rewraps an IngestError', () => {
    const err = new IngestError('DOCUMENT_NOT_FOUND', 'gone');
    expect(classifyDbError(err)).toBe(err);
  });

  it('survives a cause cycle', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(classifyDbError(a)).toBe(a);
  });
});
