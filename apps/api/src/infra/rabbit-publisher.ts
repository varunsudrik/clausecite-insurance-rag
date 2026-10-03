import { INGEST_EXCHANGE, publishIngestJob, type RabbitConnection } from '@clausecite/core';

/** The broker could not be reached (or timed out). Callers treat it like any other publish failure. */
export class BrokerUnavailableError extends Error {
  override name = 'BrokerUnavailableError';
}

type Logger = { log(m: string): void; warn(m: string): void; error(m: string): void };
type Connect = (onClose: () => void) => Promise<RabbitConnection>;

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** `scheme://user:pass@host` becomes `scheme://***@host`: broker URLs carry credentials. */
const redactCredentials = (text: string): string =>
  text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1***@');

/**
 * A short, log-safe reason. A refused connection surfaces as an AggregateError with an empty message
 * but a `code`; any URL in the text has its credentials stripped.
 */
const reasonOf = (err: unknown): string => {
  const { message, code } = (err ?? {}) as { message?: string; code?: string };
  return redactCredentials(message || code || String(err));
};

/**
 * The API's only door to RabbitMQ (DECISIONS 011). Unlike the crash-only worker (DECISIONS 004) the
 * API needs the broker just for uploads and re-ingest, so it must boot, serve chat/search and answer
 * `/health` without one: it connects lazily, never exits the process, forgets a connection the broker
 * closed and reconnects on the next use.
 */
export class RabbitPublisher {
  private conn: RabbitConnection | null = null;
  private connecting: Promise<RabbitConnection> | null = null;
  private closed = false;
  /** Reason of the last connect failure that was logged; null once a connect succeeds. */
  private lastFailure: string | null = null;

  constructor(
    private readonly connect: Connect,
    private readonly logger: Logger,
    private readonly opts: { connectTimeoutMs?: number } = {},
  ) {}

  isConnected(): boolean {
    return this.conn !== null;
  }

  /** Resolves with a live connection, opening one if needed; concurrent callers share one attempt. */
  ensureConnected(): Promise<RabbitConnection> {
    if (this.conn) return Promise.resolve(this.conn);
    if (this.closed) return Promise.reject(new BrokerUnavailableError('publisher closed'));
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<RabbitConnection> {
    const timeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    // The connection this attempt produced. A late 'close' from an older connection must not
    // forget a newer, healthy one, so the callback only acts while its own connection is cached.
    let opened: RabbitConnection | undefined;
    let attempt: Promise<RabbitConnection> | undefined;
    try {
      attempt = this.connect(() => {
        if (!opened || this.conn !== opened) return;
        this.logger.warn('RabbitMQ connection closed; will reconnect on next use');
        this.conn = null;
        // A channel-level close leaves the TCP connection open: release it rather than leak it.
        void opened.close().catch(() => undefined);
      });
      opened = await Promise.race([
        attempt,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`connect timed out after ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ]);
      this.conn = opened;
      this.logger.log(
        this.lastFailure === null ? 'RabbitMQ connected' : 'RabbitMQ connected (recovered)',
      );
      this.lastFailure = null;
      return opened;
    } catch (err) {
      const reason = reasonOf(err);
      // Only on a state change: a broker that stays down is polled by every health check and upload.
      if (reason !== this.lastFailure) {
        this.lastFailure = reason;
        this.logger.warn(`RabbitMQ connect failed: ${reason}`);
      }
      // An attempt that outlives its timeout must not leave an orphan connection behind.
      void attempt?.then((late) => late.close()).catch(() => undefined);
      throw new BrokerUnavailableError(`RabbitMQ unavailable: ${reason}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  async publishIngestJob(documentId: string): Promise<void> {
    const conn = await this.ensureConnected();
    await publishIngestJob(conn.channel, documentId);
  }

  /** True if the broker answers within `timeoutMs`: connects if needed, then checks the ingest exchange. */
  async checkHealthy(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          const conn = await this.ensureConnected();
          await conn.channel.checkExchange(INGEST_EXCHANGE);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const conn = this.conn ?? (await this.connecting?.catch(() => null)) ?? null;
    this.conn = null;
    await conn?.close();
  }
}
