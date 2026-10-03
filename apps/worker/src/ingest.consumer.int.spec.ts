import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  connectRabbit,
  documents,
  eq,
  INGEST_DLQ,
  ingestDocument,
  IngestError,
  publishIngestJob,
  type IngestResult,
  type RabbitConnection,
} from '@clausecite/core';
import { mockEmbeddingModel, startTestDb, type TestDb } from '@clausecite/core/testing';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IngestConsumer } from './ingest.consumer.js';

const FIXTURE = fileURLToPath(new URL('../../../data/fixtures/sample-policy.pdf', import.meta.url));
const DELAYS = [200, 200, 200];
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

let t: TestDb;
let mq: StartedRabbitMQContainer;
let rabbit: RabbitConnection;

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
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runConsumer(ingest: (id: string) => Promise<IngestResult>) {
  const consumer = new IngestConsumer({
    channel: rabbit.channel,
    db: t.db,
    ingest,
    retryDelaysMs: DELAYS,
    logger: quiet,
  });
  await consumer.start();
  return consumer;
}

describe('IngestConsumer', () => {
  it('ingests a published job to ready', async () => {
    const doc = await insertDoc();
    const consumer = await runConsumer((id) =>
      ingestDocument(
        { db: t.db, embeddingModel: mockEmbeddingModel(), embeddingModelId: 'mock' },
        id,
      ),
    );
    await publishIngestJob(rabbit.channel, doc.id);
    const row = await waitForStatus(doc.id, 'ready');
    expect(row.chunkCount).toBeGreaterThan(0);
    await consumer.stop();
  });

  it('retries retryable failures 3 times, then dead-letters (4 tries total)', async () => {
    const doc = await insertDoc();
    let calls = 0;
    const consumer = await runConsumer(async () => {
      calls++;
      throw new IngestError('EMBEDDING_FAILED', 'provider down');
    });
    await publishIngestJob(rabbit.channel, doc.id);
    const row = await waitForStatus(doc.id, 'failed');
    expect(calls).toBe(4);
    expect(row).toMatchObject({ attempts: 4, error: 'EMBEDDING_FAILED: provider down' });
    const dead = await rabbit.channel.get(INGEST_DLQ, { noAck: true });
    expect(dead && JSON.parse(dead.content.toString())).toMatchObject({
      documentId: doc.id,
      attempt: 4,
    });
    await consumer.stop();
  });

  it('dead-letters non-retryable failures immediately', async () => {
    const doc = await insertDoc();
    let calls = 0;
    const consumer = await runConsumer(async () => {
      calls++;
      throw new IngestError('NO_TEXT_LAYER', 'scanned');
    });
    await publishIngestJob(rabbit.channel, doc.id);
    const row = await waitForStatus(doc.id, 'failed');
    expect(calls).toBe(1);
    expect(row.attempts).toBe(1);
    await rabbit.channel.get(INGEST_DLQ, { noAck: true }); // drain
    await consumer.stop();
  });
});
