import {
  describeError,
  INGEST_QUEUE,
  isRetryable,
  markIngestFailed,
  markIngestRetrying,
  parseIngestJob,
  publishDeadLetter,
  publishRetry,
  type AmqpConfirmChannel,
  type Db,
  type IngestJob,
  type IngestResult,
} from '@clausecite/core';
import type { ConsumeMessage } from 'amqplib';

export interface IngestConsumerDeps {
  channel: AmqpConfirmChannel;
  db: Db;
  ingest: (documentId: string) => Promise<IngestResult>;
  retryDelaysMs: number[];
  logger: { log(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export class IngestConsumer {
  private consumerTag?: string;

  constructor(private readonly deps: IngestConsumerDeps) {}

  async start(prefetch = 2): Promise<void> {
    await this.deps.channel.prefetch(prefetch);
    const { consumerTag } = await this.deps.channel.consume(INGEST_QUEUE, (msg) => {
      if (msg) void this.handle(msg);
    });
    this.consumerTag = consumerTag;
  }

  async stop(): Promise<void> {
    if (this.consumerTag) await this.deps.channel.cancel(this.consumerTag);
    this.consumerTag = undefined;
  }

  async handle(msg: ConsumeMessage): Promise<void> {
    const { channel, db, logger, retryDelaysMs } = this.deps;
    let job: IngestJob;
    try {
      job = parseIngestJob(msg.content);
    } catch {
      logger.error('dropping malformed ingest message');
      channel.nack(msg, false, false);
      return;
    }

    try {
      const res = await this.deps.ingest(job.documentId);
      logger.log(
        `ingested ${job.documentId}: ${res.chunkCount} chunks from ${res.pageCount} pages`,
      );
    } catch (err) {
      const attempts = job.attempt + 1;
      try {
        if (isRetryable(err) && job.attempt < retryDelaysMs.length) {
          const delay = retryDelaysMs[job.attempt];
          await markIngestRetrying(db, job.documentId, err, attempts);
          await publishRetry(channel, { documentId: job.documentId, attempt: attempts }, delay);
          logger.warn(
            `retry ${attempts}/${retryDelaysMs.length} in ${delay}ms for ${job.documentId}: ${describeError(err)}`,
          );
        } else {
          await markIngestFailed(db, job.documentId, err, attempts);
          await publishDeadLetter(
            channel,
            { documentId: job.documentId, attempt: attempts },
            describeError(err),
          );
          logger.error(`dead-lettered ${job.documentId}: ${describeError(err)}`);
        }
      } catch (scheduleErr) {
        logger.error(`could not schedule follow-up for ${job.documentId}: ${String(scheduleErr)}`);
        channel.nack(msg, false, true);
        return;
      }
    }
    channel.ack(msg);
  }
}
