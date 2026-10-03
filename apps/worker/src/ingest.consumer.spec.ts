import type { AmqpConfirmChannel, Db } from '@clausecite/core';
import type { ConsumeMessage } from 'amqplib';
import { describe, expect, it, vi } from 'vitest';
import { IngestConsumer } from './ingest.consumer.js';

const result = { pageCount: 1, chunkCount: 1, embeddingTokens: 1 };
const message = (body: unknown) =>
  ({ content: Buffer.from(JSON.stringify(body)) }) as ConsumeMessage;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(ingest: (id: string) => Promise<typeof result>) {
  let deliver: (msg: ConsumeMessage | null) => void = () => undefined;
  const channel = {
    prefetch: vi.fn(async () => undefined),
    consume: vi.fn(async (_queue: string, cb: (msg: ConsumeMessage | null) => void) => {
      deliver = cb;
      return { consumerTag: 'tag' };
    }),
    cancel: vi.fn(async () => undefined),
    ack: vi.fn(),
    nack: vi.fn(),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onFatal = vi.fn();
  const consumer = new IngestConsumer({
    channel: channel as unknown as AmqpConfirmChannel,
    db: {} as Db,
    ingest,
    retryDelaysMs: [10],
    logger,
    onFatal,
  });
  return {
    consumer,
    channel,
    logger,
    onFatal,
    deliver: (msg: ConsumeMessage | null) => deliver(msg),
  };
}

describe('IngestConsumer (unit)', () => {
  it('escalates when the broker cancels the consumer', async () => {
    const s = setup(async () => result);
    await s.consumer.start();
    s.deliver(null);
    expect(s.onFatal).toHaveBeenCalledTimes(1);
    expect(s.onFatal.mock.calls[0][0]).toBe('consumer cancelled by broker');
  });

  it('does not treat its own cancel as fatal', async () => {
    const s = setup(async () => result);
    await s.consumer.start();
    await s.consumer.stop();
    s.deliver(null);
    expect(s.onFatal).not.toHaveBeenCalled();
  });

  it('escalates once and takes no new work after a fatal state', async () => {
    const ingest = vi.fn(async () => result);
    const s = setup(ingest);
    await s.consumer.start();
    s.deliver(null);
    s.deliver(null);
    s.deliver(message({ documentId: 'd1', attempt: 0 }));
    await sleep(10);
    expect(s.onFatal).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('escalates an unexpected handler failure instead of leaving an unhandled rejection', async () => {
    const s = setup(async () => result);
    const boom = new Error('channel closed');
    s.channel.ack.mockImplementation(() => {
      throw boom;
    });
    await s.consumer.start();
    s.deliver(message({ documentId: 'd1', attempt: 0 }));
    await vi.waitFor(() => expect(s.onFatal).toHaveBeenCalledTimes(1));
    expect(s.onFatal).toHaveBeenCalledWith('unhandled consumer error', boom);
  });

  it('stop() resolves only after in-flight jobs finish and are acked', async () => {
    let finish: () => void = () => undefined;
    const s = setup(() => new Promise((resolve) => (finish = () => resolve(result))));
    await s.consumer.start();
    s.deliver(message({ documentId: 'd1', attempt: 0 }));

    let stopped = false;
    const stopping = s.consumer.stop().then(() => (stopped = true));
    await sleep(30);
    expect(s.channel.cancel).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(false);
    expect(s.channel.ack).not.toHaveBeenCalled();

    finish();
    await stopping;
    expect(s.channel.ack).toHaveBeenCalledTimes(1);
  });

  it('stop() gives up waiting after the timeout', async () => {
    const s = setup(() => new Promise(() => undefined));
    await s.consumer.start();
    s.deliver(message({ documentId: 'd1', attempt: 0 }));
    const started = Date.now();
    await s.consumer.stop(40);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining('still running'));
  });
});
