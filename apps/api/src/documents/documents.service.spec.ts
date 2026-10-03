import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DbHandle, DocumentRow } from '@clausecite/core';
import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerUnavailableError, type RabbitPublisher } from '../infra/rabbit-publisher.js';
import type { ApiConfig } from '../infra/tokens.js';
import { DocumentsService, errorCode, toPublicDocument } from './documents.service.js';

const PDF = Buffer.from('%PDF-1.4\nfake body');
const SHA = createHash('sha256').update(PDF).digest('hex');
const META = { slug: 'my-policy', title: 'T', insurer: 'I', product: 'P', policy_type: 'health' };

const row = (over: Partial<DocumentRow> = {}) =>
  ({
    id: 'doc-1',
    slug: 'my-policy',
    status: 'queued',
    error: null,
    filePath: `${SHA}.pdf`,
    sha256: SHA,
    ...over,
  }) as DocumentRow;

/** A drizzle-ish stub: `selects` are consumed in call order, `insertError` makes the insert reject. */
function fakeDb(opts: { selects: unknown[][]; insertError?: unknown; deleteError?: unknown }) {
  const selects = [...opts.selects];
  const update = { set: vi.fn(), where: vi.fn(async () => undefined) };
  update.set.mockReturnValue({ where: update.where });
  const del = vi.fn(async () => {
    if (opts.deleteError) throw opts.deleteError;
  });
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => selects.shift() ?? [] }) }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => {
          if (opts.insertError) throw opts.insertError;
          return [row()];
        },
      }),
    }),
    update: () => ({ set: update.set }),
    delete: () => ({ where: del }),
  };
  return { db, update, del };
}

let storageDir: string;
beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'clausecite-unit-'));
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(storageDir, { recursive: true, force: true });
});

function makeService(db: unknown, publishError?: Error) {
  const publish = vi.fn(async (_documentId: string) => {
    if (publishError) throw publishError;
  });
  const rabbit = { publishIngestJob: publish } as unknown as RabbitPublisher;
  const service = new DocumentsService({ db } as unknown as DbHandle, rabbit, {
    STORAGE_DIR: storageDir,
  } as ApiConfig);
  return { service, publish };
}

const uniqueViolation = (wrapped: boolean) => {
  const pg = Object.assign(new Error('duplicate key value'), { code: '23505' });
  return wrapped ? Object.assign(new Error('Failed query: insert'), { cause: pg }) : pg;
};

describe('DocumentsService.upload', () => {
  it('rejects bytes that are not a PDF', async () => {
    const { service } = makeService(fakeDb({ selects: [] }).db);
    await expect(service.upload(Buffer.from('nope'), META)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([true, false])(
    'treats a lost insert race on identical bytes as a dedupe (driver error wrapped: %s)',
    async (wrapped) => {
      const winner = row({ id: 'winner' });
      const { db } = fakeDb({
        selects: [[], [], [winner]],
        insertError: uniqueViolation(wrapped),
      });
      const { service, publish } = makeService(db);
      await expect(service.upload(PDF, META)).resolves.toEqual({ doc: winner, deduplicated: true });
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it('treats a lost insert race on the slug as a conflict', async () => {
    const { db } = fakeDb({
      selects: [[], [], [], [{ id: 'other' }]],
      insertError: uniqueViolation(true),
    });
    const { service, publish } = makeService(db);
    await expect(service.upload(PDF, META)).rejects.toBeInstanceOf(ConflictException);
    expect(publish).not.toHaveBeenCalled();
  });

  it('rethrows insert errors that are not unique violations', async () => {
    const boom = new Error('connection reset');
    const { db } = fakeDb({ selects: [[], []], insertError: boom });
    const { service } = makeService(db);
    await expect(service.upload(PDF, META)).rejects.toBe(boom);
  });

  it('deletes the row and answers 503 when the job cannot be enqueued, keeping the file', async () => {
    const { db, del } = fakeDb({ selects: [[], []] });
    const { service } = makeService(db, new Error('nack'));
    await expect(service.upload(PDF, META)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(del).toHaveBeenCalledOnce();
    expect(await readdir(storageDir)).toEqual([`${SHA}.pdf`]);
  });

  it('treats an unreachable broker like any other enqueue failure: row deleted, 503', async () => {
    const { db, del } = fakeDb({ selects: [[], []] });
    const { service, publish } = makeService(
      db,
      new BrokerUnavailableError('RabbitMQ unavailable: ECONNREFUSED'),
    );
    await expect(service.upload(PDF, META)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(publish).toHaveBeenCalledWith('doc-1');
    expect(del).toHaveBeenCalledOnce();
  });

  it('marks the row failed when the rollback delete also fails', async () => {
    const { db, update } = fakeDb({ selects: [[], []], deleteError: new Error('db down') });
    const { service } = makeService(db, new Error('nack'));
    await expect(service.upload(PDF, META)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(update.set).toHaveBeenCalledWith({ status: 'failed', error: 'ENQUEUE_FAILED: nack' });
  });

  it('never rewrites a stored file that already exists and leaves no temp files', async () => {
    await writeFile(join(storageDir, `${SHA}.pdf`), 'already here');
    const { db } = fakeDb({ selects: [[], []] });
    const { service } = makeService(db);
    await service.upload(PDF, META);
    expect(await readFile(join(storageDir, `${SHA}.pdf`), 'utf8')).toBe('already here');
    expect(await readdir(storageDir)).toEqual([`${SHA}.pdf`]);
  });

  it('writes a new file whole under its sha256 name without leaving temp files', async () => {
    const { db } = fakeDb({ selects: [[], []] });
    const { service } = makeService(db);
    await service.upload(PDF, META);
    expect(await readdir(storageDir)).toEqual([`${SHA}.pdf`]);
    expect(Buffer.compare(await readFile(join(storageDir, `${SHA}.pdf`)), PDF)).toBe(0);
  });
});

describe('error visibility', () => {
  it.each([
    ['PARSE_FAILED: cannot read /srv/x.pdf', 'PARSE_FAILED'],
    ['ENQUEUE_FAILED:no space', 'ENQUEUE_FAILED'],
    ['PDF_TOO_LARGE', 'PDF_TOO_LARGE'],
    ['something broke near /srv/data', 'ERROR'],
    [': details only', 'ERROR'],
  ])('errorCode(%j) is %j', (input, expected) => {
    expect(errorCode(input)).toBe(expected);
  });

  it('shows admins the full error and everyone else only the code, never filePath or sha256', () => {
    const failed = row({ status: 'failed', error: 'PARSE_FAILED: boom at /srv/x.pdf' });
    expect(toPublicDocument(failed, 'admin').error).toBe('PARSE_FAILED: boom at /srv/x.pdf');
    expect(toPublicDocument(failed, 'guest').error).toBe('PARSE_FAILED');
    expect(toPublicDocument(failed).error).toBe('PARSE_FAILED');
    expect(toPublicDocument(row(), 'guest').error).toBeNull();
    for (const role of ['admin', 'guest', undefined] as const) {
      const pub = toPublicDocument(failed, role);
      expect(pub).not.toHaveProperty('filePath');
      expect(pub).not.toHaveProperty('sha256');
    }
  });
});
