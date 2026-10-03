import { describe, expect, it } from 'vitest';
import { parseIngestJob, retryQueueName } from './topology.js';

const buf = (value: unknown) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));

describe('parseIngestJob', () => {
  it('parses a job and defaults the attempt to 0', () => {
    expect(parseIngestJob(buf({ documentId: 'd1', attempt: 2 }))).toEqual({
      documentId: 'd1',
      attempt: 2,
    });
    expect(parseIngestJob(buf({ documentId: 'd1' }))).toEqual({ documentId: 'd1', attempt: 0 });
  });

  it.each([
    ['negative attempt', { documentId: 'd1', attempt: -1 }],
    ['fractional attempt', { documentId: 'd1', attempt: 1.5 }],
    ['non-numeric attempt', { documentId: 'd1', attempt: '1' }],
    ['missing documentId', { attempt: 0 }],
    ['non-string documentId', { documentId: 7, attempt: 0 }],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['not JSON', 'not json'],
  ])('rejects %s', (_name, payload) => {
    expect(() => parseIngestJob(buf(payload))).toThrow();
  });
});

describe('retryQueueName', () => {
  it('names one queue per delay', () => {
    expect(retryQueueName(10_000)).toBe('ingest.document.retry.10000');
  });
});
