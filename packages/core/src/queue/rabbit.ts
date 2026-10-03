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

/**
 * Crash-only: if the broker connection or channel drops, `onClose` fires and the process should exit
 * (Docker restarts it). A failure during setup rejects instead - the caller already sees it - and the
 * half-open connection is closed first.
 */
export async function connectRabbit(
  url: string,
  opts: { retryDelaysMs: number[]; onClose?: (err?: unknown) => void },
): Promise<RabbitConnection> {
  const connection = await amqp.connect(url);
  let closing = false;
  let ready = false;
  const report = (err?: unknown) => {
    if (ready && !closing) opts.onClose?.(err);
  };
  // Registered straight away: an unhandled 'error' event would throw, and a drop during setup
  // must not go unnoticed. A 'close' event always follows an 'error'.
  connection.on('error', () => undefined);
  connection.on('close', report);

  let channel: ConfirmChannel;
  try {
    channel = await connection.createConfirmChannel();
    channel.on('error', () => undefined);
    channel.on('close', report);
    await assertIngestTopology(channel, opts.retryDelaysMs);
  } catch (err) {
    closing = true;
    await connection.close().catch(() => undefined);
    throw err;
  }
  ready = true;

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
