import { describe, expect, it, vi } from 'vitest';
import { BrokerUnavailableError, RabbitPublisher } from './rabbit-publisher.js';

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeConnection() {
  const handlers: { onClose?: () => void } = {};
  const conn = {
    connection: {},
    channel: { checkExchange: vi.fn(async () => ({})) },
    close: vi.fn(async () => undefined),
  };
  return { conn, handlers };
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
});
