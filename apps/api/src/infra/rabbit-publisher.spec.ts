import { describe, expect, it, vi } from 'vitest';
import { BrokerUnavailableError, RabbitPublisher } from './rabbit-publisher.js';

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

const loud = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

function fakeConnection() {
  const conn = {
    connection: {},
    channel: { checkExchange: vi.fn(async () => ({})) },
    close: vi.fn(async () => undefined),
  };
  return { conn };
}

describe('RabbitPublisher', () => {
  it('connects lazily and reuses the connection', async () => {
    const { conn } = fakeConnection();
    const connect = vi.fn(async () => conn as never);
    const p = new RabbitPublisher(connect, quiet);
    expect(p.isConnected()).toBe(false);
    await p.ensureConnected();
    await p.ensureConnected();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(p.isConnected()).toBe(true);
  });

  it('serializes concurrent connects', async () => {
    const { conn } = fakeConnection();
    let resolve!: (v: unknown) => void;
    const connect = vi.fn(() => new Promise((r) => (resolve = r)) as never);
    const p = new RabbitPublisher(connect, quiet);
    const a = p.ensureConnected();
    const b = p.ensureConnected();
    resolve(conn);
    await Promise.all([a, b]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('rejects with BrokerUnavailableError on connect failure or timeout, then retries next call', async () => {
    const { conn } = fakeConnection();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(conn);
    const p = new RabbitPublisher(connect, quiet, { connectTimeoutMs: 50 });
    await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(p.ensureConnected()).resolves.toBe(conn);
  });

  it('names the reason even when the driver error has an empty message', async () => {
    const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    const p = new RabbitPublisher(vi.fn().mockRejectedValue(refused), quiet);
    await expect(p.ensureConnected()).rejects.toThrow('RabbitMQ unavailable: ECONNREFUSED');
  });

  it('drops the connection when the broker closes it and reconnects on next use', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    let onClose: (() => void) | undefined;
    const connect = vi
      .fn()
      .mockImplementationOnce(async (cb: () => void) => ((onClose = cb), first.conn))
      .mockImplementationOnce(async () => second.conn);
    const p = new RabbitPublisher(connect, quiet);
    await p.ensureConnected();
    onClose?.();
    expect(p.isConnected()).toBe(false);
    await expect(p.ensureConnected()).resolves.toBe(second.conn);
  });

  it('checkHealthy returns false instead of throwing', async () => {
    const p = new RabbitPublisher(vi.fn().mockRejectedValue(new Error('down')), quiet);
    await expect(p.checkHealthy(50)).resolves.toBe(false);
  });

  it('releases the dropped connection, and a stale close from it cannot drop its replacement', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    let staleOnClose: (() => void) | undefined;
    const connect = vi
      .fn()
      .mockImplementationOnce(async (cb: () => void) => ((staleOnClose = cb), first.conn))
      .mockImplementationOnce(async () => second.conn);
    const p = new RabbitPublisher(connect, quiet);
    await p.ensureConnected();
    staleOnClose?.();
    expect(first.conn.close).toHaveBeenCalledOnce();
    await p.ensureConnected();
    staleOnClose?.();
    expect(p.isConnected()).toBe(true);
    await expect(p.ensureConnected()).resolves.toBe(second.conn);
    expect(second.conn.close).not.toHaveBeenCalled();
  });

  it('closes a connection that only arrives after its attempt timed out', async () => {
    const late = fakeConnection();
    let resolve!: (v: unknown) => void;
    const connect = vi.fn(() => new Promise((r) => (resolve = r)) as never);
    const p = new RabbitPublisher(connect, quiet, { connectTimeoutMs: 20 });
    await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
    resolve(late.conn);
    await vi.waitFor(() => expect(late.conn.close).toHaveBeenCalledOnce());
    expect(p.isConnected()).toBe(false);
  });

  it('publishes the ingest job on the connected channel', async () => {
    const { conn } = fakeConnection();
    const publish = vi.fn(
      (_ex: string, _key: string, _body: Buffer, _opts: unknown, cb: (e: Error | null) => void) => {
        cb(null);
        return true;
      },
    );
    Object.assign(conn.channel, { publish });
    const p = new RabbitPublisher(async () => conn as never, quiet);
    await p.publishIngestJob('doc-1');
    expect(publish).toHaveBeenCalledOnce();
    expect(JSON.parse(publish.mock.calls[0]![2].toString())).toEqual({
      documentId: 'doc-1',
      attempt: 0,
    });
  });

  it('publishIngestJob rejects with BrokerUnavailableError while the broker is down', async () => {
    const p = new RabbitPublisher(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), quiet);
    await expect(p.publishIngestJob('doc-1')).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('checkHealthy is true when the exchange exists and false when it hangs past the timeout', async () => {
    const ok = fakeConnection();
    await expect(
      new RabbitPublisher(async () => ok.conn as never, quiet).checkHealthy(50),
    ).resolves.toBe(true);
    expect(ok.conn.channel.checkExchange).toHaveBeenCalledWith('ingest');

    const hung = fakeConnection();
    hung.conn.channel.checkExchange.mockImplementation(() => new Promise(() => undefined));
    await expect(
      new RabbitPublisher(async () => hung.conn as never, quiet).checkHealthy(20),
    ).resolves.toBe(false);
  });

  it('close() closes the connection; afterwards nothing reconnects', async () => {
    const { conn } = fakeConnection();
    const connect = vi.fn(async () => conn as never);
    const p = new RabbitPublisher(connect, quiet);
    await p.ensureConnected();
    await p.close();
    expect(conn.close).toHaveBeenCalledOnce();
    expect(p.isConnected()).toBe(false);
    await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('closes a connection that resolves after close() was called, and refuses to reconnect', async () => {
    const late = fakeConnection();
    let resolve!: (v: unknown) => void;
    const connect = vi.fn(() => new Promise((r) => (resolve = r)) as never);
    const p = new RabbitPublisher(connect, quiet);
    const pending = p.ensureConnected();
    const closing = p.close();
    resolve(late.conn);
    await pending;
    await closing;
    expect(late.conn.close).toHaveBeenCalledOnce();
    expect(p.isConnected()).toBe(false);
    const after = p.ensureConnected();
    await expect(after).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(after).rejects.toThrow('publisher closed');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  describe('connect diagnostics (logged on state change only)', () => {
    it('logs the first failure once with its reason, stays quiet on identical repeats, logs recovery once', async () => {
      const { conn } = fakeConnection();
      const logger = loud();
      const refused = () => new Error('ACCESS_REFUSED - Login was refused');
      const connect = vi
        .fn()
        .mockRejectedValueOnce(refused())
        .mockRejectedValueOnce(refused())
        .mockRejectedValueOnce(refused())
        .mockResolvedValueOnce(conn);
      const p = new RabbitPublisher(connect, logger);

      await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(String(logger.warn.mock.calls[0]![0])).toContain('ACCESS_REFUSED - Login was refused');

      await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
      await expect(p.checkHealthy(50)).resolves.toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.log).not.toHaveBeenCalled();

      await expect(p.ensureConnected()).resolves.toBe(conn);
      expect(logger.log).toHaveBeenCalledOnce();
      expect(logger.log).toHaveBeenCalledWith('RabbitMQ connected (recovered)');
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('logs again when the failure reason changes', async () => {
      const logger = loud();
      const connect = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('PRECONDITION_FAILED - inequivalent arg x-message-ttl'));
      const p = new RabbitPublisher(connect, logger);
      await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
      await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(String(logger.warn.mock.calls[1]![0])).toContain('PRECONDITION_FAILED');
    });

    it('logs a plain first connect as "connected", not "recovered"', async () => {
      const { conn } = fakeConnection();
      const logger = loud();
      await new RabbitPublisher(async () => conn as never, logger).ensureConnected();
      expect(logger.log).toHaveBeenCalledExactlyOnceWith('RabbitMQ connected');
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs a connect timeout once and a failure after losing an established connection', async () => {
      const first = fakeConnection();
      const logger = loud();
      let onClose: (() => void) | undefined;
      const connect = vi
        .fn()
        .mockImplementationOnce(async (cb: () => void) => ((onClose = cb), first.conn))
        .mockImplementation(() => new Promise(() => undefined));
      const p = new RabbitPublisher(connect, logger, { connectTimeoutMs: 20 });
      await p.ensureConnected();
      onClose?.();
      expect(logger.warn).toHaveBeenCalledTimes(1); // the close itself

      await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
      await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
      expect(logger.warn).toHaveBeenCalledTimes(2); // + one "connect failed", not one per attempt
      expect(String(logger.warn.mock.calls[1]![0])).toContain('connect timed out after 20 ms');
    });

    it('redacts credentials from URLs in the logged reason and in the thrown error', async () => {
      const logger = loud();
      const leaky = new Error('cannot reach amqp://guest:s3cret@rabbit.internal:5672/vhost');
      const p = new RabbitPublisher(vi.fn().mockRejectedValue(leaky), logger);
      const error = (await p.ensureConnected().then(
        () => undefined,
        (e: unknown) => e,
      )) as Error;
      const logged = String(logger.warn.mock.calls[0]![0]);
      for (const text of [logged, error.message]) {
        expect(text).toContain('amqp://***@rabbit.internal:5672/vhost');
        expect(text).not.toContain('s3cret');
        expect(text).not.toContain('guest');
      }
    });
  });
});
