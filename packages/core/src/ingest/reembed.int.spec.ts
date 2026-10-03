import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { documents } from '../db/schema.js';
import { startTestDb, type TestDb } from '../testing/postgres.js';
import { reembedStale } from './reembed.js';

const MODEL = 'new/model';
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t?.stop();
});
// reembedStale looks at every document, so each test starts from an empty table
beforeEach(async () => {
  await t.db.delete(documents);
});

async function insertDoc(
  slug: string,
  status: 'queued' | 'processing' | 'ready' | 'failed',
  embeddingModel: string | null,
  extra: { attempts?: number; error?: string } = {},
) {
  const [doc] = await t.db
    .insert(documents)
    .values({
      slug,
      title: slug,
      insurer: 'Acme',
      product: 'Sample Health Shield',
      policyType: 'health',
      filePath: `${slug}.pdf`,
      sha256: randomUUID(),
      status,
      embeddingModel,
      ...extra,
    })
    .returning();
  return doc;
}

const row = async (id: string) =>
  (await t.db.select().from(documents).where(eq(documents.id, id)))[0];

describe('reembedStale', () => {
  it('re-enqueues ready documents embedded with another model, or none, and nothing else', async () => {
    const old = await insertDoc('a-old', 'ready', 'old/model', { attempts: 2, error: 'stale' });
    const none = await insertDoc('b-none', 'ready', null);
    const current = await insertDoc('c-current', 'ready', MODEL);
    const failed = await insertDoc('d-failed', 'failed', 'old/model');
    const queued = await insertDoc('e-queued', 'queued', null);
    const processing = await insertDoc('f-processing', 'processing', 'old/model');
    const publish = vi.fn(async (_id: string) => undefined);
    const log = vi.fn();

    const count = await reembedStale({ db: t.db, embeddingModel: MODEL, publish, log });

    expect(count).toBe(2);
    expect(publish.mock.calls.map(([id]) => id)).toEqual([old.id, none.id]); // ordered by slug
    expect(await row(old.id)).toMatchObject({ status: 'queued', attempts: 0, error: null });
    expect(await row(none.id)).toMatchObject({ status: 'queued', attempts: 0, error: null });
    expect((await row(current.id)).status).toBe('ready');
    expect(await row(failed.id)).toMatchObject({ status: 'failed', embeddingModel: 'old/model' });
    expect((await row(queued.id)).status).toBe('queued');
    expect((await row(processing.id)).status).toBe('processing');
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `a-old: old/model → ${MODEL}`,
      `b-none: (none) → ${MODEL}`,
    ]);
  });

  it('only lists on a dry run: no row changes, nothing published', async () => {
    const old = await insertDoc('a-old', 'ready', 'old/model', { attempts: 1, error: 'stale' });
    const none = await insertDoc('b-none', 'ready', null);
    const publish = vi.fn(async (_id: string) => undefined);
    const log = vi.fn();

    const count = await reembedStale({
      db: t.db,
      embeddingModel: MODEL,
      dryRun: true,
      publish,
      log,
    });

    expect(count).toBe(2);
    expect(publish).not.toHaveBeenCalled();
    expect(await row(old.id)).toMatchObject({ status: 'ready', attempts: 1, error: 'stale' });
    expect(await row(none.id)).toMatchObject({ status: 'ready', embeddingModel: null });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('does nothing when every ready document already uses the model', async () => {
    await insertDoc('a-current', 'ready', MODEL);
    const publish = vi.fn(async (_id: string) => undefined);
    expect(await reembedStale({ db: t.db, embeddingModel: MODEL, publish, log: vi.fn() })).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('reverts a document whose publish failed to ready, keeps earlier ones enqueued, and rethrows', async () => {
    const first = await insertDoc('a-first', 'ready', 'old/model');
    const second = await insertDoc('b-second', 'ready', 'old/model');
    const third = await insertDoc('c-third', 'ready', 'old/model');
    const published: string[] = [];
    const publish = async (id: string) => {
      published.push(id);
      if (published.length === 2) throw new Error('broker nack');
    };
    const log = vi.fn();

    await expect(reembedStale({ db: t.db, embeddingModel: MODEL, publish, log })).rejects.toThrow(
      'broker nack',
    );

    expect(published).toEqual([first.id, second.id]); // stopped at the failure: the third is never tried
    expect((await row(first.id)).status).toBe('queued'); // processed before the failure: stays enqueued
    expect(await row(second.id)).toMatchObject({ status: 'ready', embeddingModel: 'old/model' }); // not stranded
    expect(await row(third.id)).toMatchObject({ status: 'ready', embeddingModel: 'old/model' }); // untouched
    expect(log).toHaveBeenCalledWith('failed to enqueue b-second: broker nack');
  });

  it('still rethrows the publish error when the revert itself fails', async () => {
    const doc = await insertDoc('a-first', 'ready', 'old/model');
    const log = vi.fn();
    const publish = async () => {
      await t.pool.query('alter table documents rename to documents_gone'); // the revert has nothing to update
      throw new Error('broker nack');
    };
    try {
      await expect(reembedStale({ db: t.db, embeddingModel: MODEL, publish, log })).rejects.toThrow(
        'broker nack',
      );
    } finally {
      await t.pool.query('alter table documents_gone rename to documents');
    }
    expect(log.mock.calls.map(([line]) => String(line))).toEqual([
      `a-first: old/model → ${MODEL}`,
      'failed to enqueue a-first: broker nack',
      expect.stringContaining('could not revert a-first to ready'),
    ]);
    expect((await row(doc.id)).status).toBe('queued'); // the one case left to manual recovery, and it is reported
  });
});
