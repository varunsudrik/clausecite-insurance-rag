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
  /**
   * Called (at most once) when the consumer reaches a state it cannot recover from: the broker
   * cancelled the consumer, a follow-up could not be recorded, or a handler failed unexpectedly.
   * Crash-only: the callee is expected to terminate the process so the supervisor restarts it.
   */
  onFatal: (reason: string, err?: unknown) => void;
}

export class IngestConsumer {
  private consumerTag?: string;
  private stopping = false;
  private fatalFired = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: IngestConsumerDeps) {}

  async start(prefetch = 2): Promise<void> {
    this.stopping = false;
    await this.deps.channel.prefetch(prefetch);
    const { consumerTag } = await this.deps.channel.consume(INGEST_QUEUE, (msg) => {
      if (!msg) {
        // amqplib delivers null when the broker cancels the consumer (queue deleted, node down...)
        if (!this.stopping) this.fatal('consumer cancelled by broker');
        return;
      }
      // After a fatal state the process is going down: take no new work. The message stays
      // unacked and the broker requeues it when the channel closes.
      if (this.fatalFired) return;
      const job: Promise<void> = this.handle(msg)
        .catch((err: unknown) => this.fatal('unhandled consumer error', err))
        .finally(() => this.inFlight.delete(job));
      this.inFlight.add(job);
    });
    this.consumerTag = consumerTag;
  }

  /** Stops taking new messages, then waits (up to `timeoutMs`) for in-flight jobs to be acked. */
  async stop(timeoutMs = 30_000): Promise<void> {
    this.stopping = true;
    if (this.consumerTag) await this.deps.channel.cancel(this.consumerTag);
    this.consumerTag = undefined;

    const pending = [...this.inFlight];
    if (pending.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([
      Promise.allSettled(pending).then(() => 'drained'),
      timedOut,
    ]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.deps.logger.warn(
        `${this.inFlight.size} ingest job(s) still running after ${timeoutMs}ms; closing anyway (the broker will redeliver them)`,
      );
    }
  }

  private fatal(reason: string, err?: unknown): void {
    if (this.fatalFired) return;
    this.fatalFired = true;
    this.deps.onFatal(reason, err);
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
        const reason = `could not schedule follow-up for ${job.documentId}: ${String(scheduleErr)}`;
        logger.error(reason);
        channel.nack(msg, false, true);
        // Without this the broker would redeliver straight into the same failure (hot loop);
        // crashing hands the retry pacing to the supervisor's restart backoff.
        this.fatal(reason, scheduleErr);
        return;
      }
    }
    channel.ack(msg);
  }
}
