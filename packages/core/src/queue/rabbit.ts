import amqp, { type ConfirmChannel } from 'amqplib';
import {
  assertIngestTopology,
  INGEST_DLQ_EXCHANGE,
  INGEST_EXCHANGE,
  INGEST_RETRY_EXCHANGE,
  INGEST_ROUTING_KEY,
  type IngestJob,
} from './topology.js';

export type AmqpConfirmChannel = ConfirmChannel;
type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

export interface RabbitConnection {
  connection: AmqpConnection;
  channel: ConfirmChannel;
  close(): Promise<void>;
}

/** Crash-only: if the broker connection drops, `onClose` fires and the process should exit (Docker restarts it). */
export async function connectRabbit(
  url: string,
  opts: { retryDelaysMs: number[]; onClose?: (err?: unknown) => void },
): Promise<RabbitConnection> {
  const connection = await amqp.connect(url);
  const channel = await connection.createConfirmChannel();
  await assertIngestTopology(channel, opts.retryDelaysMs);
  let closing = false;
  connection.on('error', () => undefined); // a 'close' event always follows
  connection.on('close', (err?: unknown) => {
    if (!closing) opts.onClose?.(err);
  });
  return {
    connection,
    channel,
    async close() {
      closing = true;
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    },
  };
}

function send(
  ch: ConfirmChannel,
  exchange: string,
  routingKey: string,
  body: object,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ch.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(body)),
      { persistent: true, contentType: 'application/json' },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

export const publishIngestJob = (ch: ConfirmChannel, documentId: string) =>
  send(ch, INGEST_EXCHANGE, INGEST_ROUTING_KEY, { documentId, attempt: 0 } satisfies IngestJob);

export const publishRetry = (ch: ConfirmChannel, job: IngestJob, delayMs: number) =>
  send(ch, INGEST_RETRY_EXCHANGE, String(delayMs), job);

export const publishDeadLetter = (ch: ConfirmChannel, job: IngestJob, error: string) =>
  send(ch, INGEST_DLQ_EXCHANGE, INGEST_ROUTING_KEY, { ...job, error });
