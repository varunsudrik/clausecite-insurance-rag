import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertIngestTopology,
  connectRabbit,
  createDb,
  documents,
  eq,
  INGEST_DLQ,
  INGEST_EXCHANGE,
  INGEST_QUEUE,
  INGEST_ROUTING_KEY,
  ingestDocument,
  IngestError,
  publishIngestJob,
  type IngestResult,
  type RabbitConnection,
} from '@clausecite/core';
import { mockEmbeddingModel, startTestDb, type TestDb } from '@clausecite/core/testing';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IngestConsumer } from './ingest.consumer.js';

const FIXTURE = fileURLToPath(new URL('../../../data/fixtures/sample-policy.pdf', import.meta.url));
// Distinct delays so a wrong delay choice or a wrong retry queue changes the total retry time.
const DELAYS = [150, 300, 450];
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let t: TestDb;
let mq: StartedRabbitMQContainer;
let rabbit: RabbitConnection;

const started: IngestConsumer[] = [];
const fatals: Array<[string, unknown]> = [];

beforeAll(async () => {
  [t, mq] = await Promise.all([
    startTestDb(),
    new RabbitMQContainer('rabbitmq:3.13-management').start(),
  ]);
  rabbit = await connectRabbit(mq.getAmqpUrl(), { retryDelaysMs: DELAYS });
});
afterAll(async () => {
  await rabbit?.close();
  await mq?.stop();
  await t?.stop();
});
afterEach(async () => {
  vi.restoreAllMocks();
  // a failed assertion must not leave a consumer behind to steal the next test's messages
  for (const consumer of started.splice(0)) await consumer.stop(1_000).catch(() => undefined);
  const unexpected = fatals.splice(0);
  expect(unexpected).toEqual([]);
});

async function insertDoc() {
  const [doc] = await t.db
    .insert(documents)
    .values({
      slug: `doc-${randomUUID()}`,
      title: 'Sample',
      insurer: 'Acme',
      product: 'Sample Health Shield',
      policyType: 'health',
      filePath: FIXTURE,
      sha256: randomUUID(),
    })
    .returning();
  return doc;
}

async function waitForStatus(id: string, status: string, timeoutMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const [row] = await t.db.select().from(documents).where(eq(documents.id, id));
    if (row.status === status) return row;
    if (Date.now() - start > timeoutMs)
      throw new Error(`timeout waiting for ${status}, got ${row.status}`);
    await sleep(100);
  }
}

/** The dead-letter publish is confirmed just after the row flips to 'failed', so poll for it. */
async function takeDeadLetter(timeoutMs = 5_000) {
  const start = Date.now();
  for (;;) {
    const msg = await rabbit.channel.get(INGEST_DLQ, { noAck: true });
    if (msg) return JSON.parse(msg.content.toString()) as Record<string, unknown>;
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for a dead letter');
    await sleep(50);
  }
}

const realIngest = (id: string) =>
  ingestDocument({ db: t.db, embeddingModel: mockEmbeddingModel(), embeddingModelId: 'mock' }, id);

async function runConsumer(ingest: (id: string) => Promise<IngestResult>) {
  const consumer = new IngestConsumer({
    channel: rabbit.channel,
    db: t.db,
    ingest,
    retryDelaysMs: DELAYS,
    logger: quiet,
    onFatal: (reason, err) => fatals.push([reason, err]),
  });
  started.push(consumer);
  await consumer.start();
  return consumer;
}

describe('IngestConsumer', () => {
  it('ingests a published job to ready', async () => {
    const doc = await insertDoc();
    await runConsumer(realIngest);
    await publishIngestJob(rabbit.channel, doc.id);
    const row = await waitForStatus(doc.id, 'ready');
    expect(row.chunkCount).toBeGreaterThan(0);
  });

  it('retries retryable failures 3 times, then dead-letters (4 tries total)', async () => {
    const doc = await insertDoc();
    let calls = 0;
    await runConsumer(async () => {
      calls++;
      throw new IngestError('EMBEDDING_FAILED', 'provider down');
    });
    const begin = Date.now();
    await publishIngestJob(rabbit.channel, doc.id);
    const row = await waitForStatus(doc.id, 'failed');
    const elapsed = Date.now() - begin;
    expect(calls).toBe(4);
    expect(row).toMatchObject({ attempts: 4, error: 'EMBEDDING_FAILED: provider down' });
    // 150 + 300 + 450 ms of retry delay, minus slack: each retry waited in its own delay queue
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(await takeDeadLetter()).toEqual({
      documentId: doc.id,
      attempt: 4,
      error: 'EMBEDDING_FAILED: provider down',
    });
  });

  it('dead-letters non-retryable failures immediately', async () => {
    const doc = await insertDoc();
    let calls = 0;
    await runConsumer(async () => {
      calls++;
      throw new IngestError('NO_TEXT_LAYER', 'scanned');
    });
    await publishIngestJob(rabbit.channel, doc.id);
    const row = await waitForStatus(doc.id, 'failed');
    expect(calls).toBe(1);
    expect(row.attempts).toBe(1);
    expect(await takeDeadLetter()).toEqual({
      documentId: doc.id,
      attempt: 1,
      error: 'NO_TEXT_LAYER: scanned',
    });
  });

  it('drops malformed messages without calling ingest or redelivering them', async () => {
    const doc = await insertDoc();
    const nack = vi.spyOn(rabbit.channel, 'nack');
    const seen: string[] = [];
    await runConsumer(async (id) => {
      seen.push(id);
      return realIngest(id);
    });
    rabbit.channel.publish(INGEST_EXCHANGE, INGEST_ROUTING_KEY, Buffer.from('not json'), {
      persistent: true,
    });
    await rabbit.channel.waitForConfirms();
    await vi.waitFor(() => expect(nack).toHaveBeenCalledTimes(1));
    expect(nack.mock.calls[0].slice(1)).toEqual([false, false]); // no requeue

    await publishIngestJob(rabbit.channel, doc.id); // the consumer keeps working
    await waitForStatus(doc.id, 'ready');
    expect(seen).toEqual([doc.id]);
    expect(nack).toHaveBeenCalledTimes(1); // the bad message did not come back
    expect((await rabbit.channel.checkQueue(INGEST_QUEUE)).messageCount).toBe(0);
  });

  it('requeues and escalates to crash-only when the follow-up cannot be recorded', async () => {
    const doc = await insertDoc();
    const brokenDb = createDb(t.url, 1);
    await brokenDb.pool.end(); // every query now rejects
    const conn = await connectRabbit(mq.getAmqpUrl(), { retryDelaysMs: DELAYS });
    const nack = vi.spyOn(conn.channel, 'nack');
    const ack = vi.spyOn(conn.channel, 'ack');
    const onFatal = vi.fn();
    const broken = new IngestConsumer({
      channel: conn.channel,
      db: brokenDb.db,
      ingest: async () => {
        throw new IngestError('EMBEDDING_FAILED', 'provider down');
      },
      retryDelaysMs: DELAYS,
      logger: quiet,
      onFatal,
    });
    try {
      await broken.start();
      await publishIngestJob(rabbit.channel, doc.id);
      await vi.waitFor(() => expect(onFatal).toHaveBeenCalled());
      const [reason, err] = onFatal.mock.calls[0];
      expect(reason).toContain('could not schedule follow-up');
      expect(err).toBeInstanceOf(Error);
      expect(nack.mock.calls[0].slice(1)).toEqual([false, true]);
      expect(ack).not.toHaveBeenCalled();
      await sleep(200); // the redelivered job must not trigger another escalation or more work
      expect(onFatal).toHaveBeenCalledTimes(1);
    } finally {
      await broken.stop(1_000);
      await conn.close(); // the unacked redelivery goes back to the queue
    }

    await runConsumer(realIngest); // a healthy worker still gets the job
    await waitForStatus(doc.id, 'ready');
  });

  it('stop() drains in-flight jobs before resolving', async () => {
    const doc = await insertDoc();
    const ack = vi.spyOn(rabbit.channel, 'ack');
    let begun: () => void = () => undefined;
    const hasBegun = new Promise<void>((resolve) => (begun = resolve));
    let finished = false;
    const consumer = await runConsumer(async (id) => {
      begun();
      await sleep(300);
      const res = await realIngest(id);
      finished = true;
      return res;
    });
    await publishIngestJob(rabbit.channel, doc.id);
    await hasBegun;
    expect(finished).toBe(false);

    await consumer.stop();

    expect(finished).toBe(true);
    expect(ack).toHaveBeenCalledTimes(1);
    const [row] = await t.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe('ready');
    expect((await rabbit.channel.checkQueue(INGEST_QUEUE)).messageCount).toBe(0);
  });

  // Last on purpose: it deletes the main queue and then restores the topology.
  it('escalates when the broker cancels the consumer', async () => {
    const conn = await connectRabbit(mq.getAmqpUrl(), { retryDelaysMs: DELAYS });
    const onFatal = vi.fn();
    const consumer = new IngestConsumer({
      channel: conn.channel,
      db: t.db,
      ingest: realIngest,
      retryDelaysMs: DELAYS,
      logger: quiet,
      onFatal,
    });
    try {
      await consumer.start();
      await rabbit.channel.deleteQueue(INGEST_QUEUE);
      await vi.waitFor(() => expect(onFatal).toHaveBeenCalled());
      expect(onFatal.mock.calls[0][0]).toBe('consumer cancelled by broker');
    } finally {
      await consumer.stop(1_000).catch(() => undefined);
      await conn.close();
      await assertIngestTopology(rabbit.channel, DELAYS);
    }
  });
});
