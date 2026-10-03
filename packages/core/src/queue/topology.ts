import type { Channel } from 'amqplib';

export type AmqpChannel = Channel;

export const INGEST_EXCHANGE = 'ingest';
export const INGEST_RETRY_EXCHANGE = 'ingest.retry';
export const INGEST_DLQ_EXCHANGE = 'ingest.dlq';
export const INGEST_QUEUE = 'ingest.document';
export const INGEST_DLQ = 'ingest.document.dlq';
export const INGEST_ROUTING_KEY = 'document';

export const retryQueueName = (delayMs: number) => `${INGEST_QUEUE}.retry.${delayMs}`;

export interface IngestJob {
  documentId: string;
  attempt: number;
}

/**
 * One retry queue per delay with a queue-level TTL that dead-letters back to the main exchange.
 * (Per-message TTLs on a single queue suffer head-of-line blocking: RabbitMQ only expires the head.)
 */
export async function assertIngestTopology(
  ch: AmqpChannel,
  retryDelaysMs: number[],
): Promise<void> {
  await ch.assertExchange(INGEST_EXCHANGE, 'direct', { durable: true });
  await ch.assertExchange(INGEST_RETRY_EXCHANGE, 'direct', { durable: true });
  await ch.assertExchange(INGEST_DLQ_EXCHANGE, 'direct', { durable: true });

  await ch.assertQueue(INGEST_QUEUE, { durable: true });
  await ch.bindQueue(INGEST_QUEUE, INGEST_EXCHANGE, INGEST_ROUTING_KEY);

  for (const delay of retryDelaysMs) {
    const q = retryQueueName(delay);
    await ch.assertQueue(q, {
      durable: true,
      messageTtl: delay,
      deadLetterExchange: INGEST_EXCHANGE,
      deadLetterRoutingKey: INGEST_ROUTING_KEY,
    });
    await ch.bindQueue(q, INGEST_RETRY_EXCHANGE, String(delay));
  }

  await ch.assertQueue(INGEST_DLQ, { durable: true });
  await ch.bindQueue(INGEST_DLQ, INGEST_DLQ_EXCHANGE, INGEST_ROUTING_KEY);
}

export function parseIngestJob(content: Buffer): IngestJob {
  const value = JSON.parse(content.toString('utf8')) as Partial<IngestJob> | null;
  const attempt = value?.attempt ?? 0;
  if (typeof value?.documentId !== 'string' || !Number.isInteger(attempt) || attempt < 0) {
    throw new Error('malformed ingest job');
  }
  return { documentId: value.documentId, attempt };
}
