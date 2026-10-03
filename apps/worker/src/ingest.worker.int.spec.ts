import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectRabbit,
  createDb,
  dbEnv,
  documents,
  eq,
  INGEST_DLQ,
  INGEST_QUEUE,
  llmEnv,
  loadEnv,
  publishIngestJob,
  rabbitEnv,
  storageEnv,
  type DbHandle,
  type RabbitConnection,
} from '@clausecite/core';
import { mockEmbeddingModel, startTestDb, type TestDb } from '@clausecite/core/testing';
import { Logger } from '@nestjs/common';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IngestWorker, type WorkerEnv } from './ingest.worker.js';

const FIXTURE = fileURLToPath(new URL('../../../data/fixtures/sample-policy.pdf', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let t: TestDb;
let mq: StartedRabbitMQContainer;
let publisher: RabbitConnection;
let storageDir: string;
let workerDb: DbHandle;
let workerRabbit: RabbitConnection;
let worker: IngestWorker;
let stopped = false;
let exit: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  Logger.overrideLogger(false); // the worker's own logs would only add noise here
  // IngestWorker's onFatal calls process.exit(1) in production; here it must not kill the test run.
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

  [t, mq, storageDir] = await Promise.all([
    startTestDb(),
    new RabbitMQContainer('rabbitmq:3.13-management').start(),
    mkdtemp(join(tmpdir(), 'clausecite-storage-')),
  ]);

  // The same env the worker module builds in production. The OpenRouter key is fake and its URL
  // unroutable: the worker must use the injected mock model, never reach for the real provider.
  const source = {
    DATABASE_URL: t.url,
    OPENROUTER_API_KEY: 'test-key-never-used',
    OPENROUTER_BASE_URL: 'http://127.0.0.1:1',
    RABBITMQ_URL: mq.getAmqpUrl(),
    INGEST_RETRY_DELAYS_MS: '100,200',
    STORAGE_DIR: storageDir,
  };
  const env: WorkerEnv = {
    ...loadEnv(dbEnv, source),
    ...loadEnv(llmEnv, source),
    ...loadEnv(rabbitEnv, source),
    ...loadEnv(storageEnv, source),
  };

  // The worker gets its own pool and broker connection (it closes them on shutdown);
  // the test keeps t.db and a separate publisher connection for setup and assertions.
  workerDb = createDb(env.DATABASE_URL, 2);
  workerRabbit = await connectRabbit(env.RABBITMQ_URL, {
    retryDelaysMs: env.INGEST_RETRY_DELAYS_MS,
  });
  publisher = await connectRabbit(env.RABBITMQ_URL, { retryDelaysMs: env.INGEST_RETRY_DELAYS_MS });

  worker = new IngestWorker(env, workerDb, workerRabbit, {
    embedding: mockEmbeddingModel(),
    ids: { embedding: 'mock-embedding' },
  });
  await worker.onApplicationBootstrap();
});

afterEach(() => {
  expect(exit).not.toHaveBeenCalled(); // the worker never hit its crash-only path
});

afterAll(async () => {
  if (!stopped) await worker?.onApplicationShutdown().catch(() => undefined);
  await publisher?.close();
  await mq?.stop();
  await t?.stop();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
  exit?.mockRestore();
});

async function insertDoc(filePath: string, sha256: string = randomUUID()) {
  const [doc] = await t.db
    .insert(documents)
    .values({
      slug: `doc-${randomUUID()}`,
      title: 'Sample',
      insurer: 'Acme',
      product: 'Sample Health Shield',
      policyType: 'health',
      filePath,
      sha256,
    })
    .returning();
  return doc;
}

async function waitForStatus(id: string, status: string, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    const [row] = await t.db.select().from(documents).where(eq(documents.id, id));
    if (row.status === status) return row;
    if (Date.now() - start > timeoutMs)
      throw new Error(`timeout waiting for ${status}, got ${row.status}`);
    await sleep(100);
  }
}

describe('IngestWorker composition (real consumer, mock models, STORAGE_DIR)', () => {
  it('reads documents.file_path names from STORAGE_DIR and ingests to ready', async () => {
    const bytes = await readFile(FIXTURE);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const name = `${sha}.pdf`; // what the API stores: a bare name, not a path
    await writeFile(join(storageDir, name), bytes);
    const doc = await insertDoc(name, sha);

    await publishIngestJob(publisher.channel, doc.id);

    const row = await waitForStatus(doc.id, 'ready');
    expect(row.chunkCount).toBeGreaterThan(0);
    expect(row.embeddingModel).toBe('mock-embedding');
    expect(row.error).toBeNull();
  });

  it('fails FILE_NOT_FOUND when the named file is not in STORAGE_DIR', async () => {
    const doc = await insertDoc(`${randomUUID()}.pdf`);

    await publishIngestJob(publisher.channel, doc.id);

    const row = await waitForStatus(doc.id, 'failed');
    expect(row.error).toMatch(/^FILE_NOT_FOUND/);
    expect(row.attempts).toBe(1); // not retryable: straight to the dead-letter queue
    await vi.waitFor(async () => {
      const dead = await publisher.channel.get(INGEST_DLQ, { noAck: true });
      expect(dead && JSON.parse(dead.content.toString())).toMatchObject({ documentId: doc.id });
    });
  });

  it('onApplicationShutdown resolves cleanly and releases the pool and the broker', async () => {
    await expect(worker.onApplicationShutdown()).resolves.toBeUndefined();
    stopped = true;
    await expect(workerDb.pool.query('select 1')).rejects.toThrow(); // pool ended
    await expect(workerRabbit.channel.checkQueue(INGEST_QUEUE)).rejects.toThrow(); // channel closed
  });
});
