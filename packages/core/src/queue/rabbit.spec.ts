import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectMock = vi.hoisted(() => vi.fn());
vi.mock('amqplib', () => ({ default: { connect: connectMock } }));

import { connectRabbit } from './rabbit.js';

class FakeChannel extends EventEmitter {
  assertExchange = vi.fn(async () => undefined);
  assertQueue = vi.fn(async () => undefined);
  bindQueue = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    this.emit('close');
  });
}

class FakeConnection extends EventEmitter {
  channel = new FakeChannel();
  /** listener counts seen at the moment the channel is requested */
  listenersAtChannelCreation = { error: -1, close: -1 };
  createConfirmChannel = vi.fn(async () => {
    this.listenersAtChannelCreation = {
      error: this.listenerCount('error'),
      close: this.listenerCount('close'),
    };
    return this.channel;
  });
  close = vi.fn(async () => {
    this.emit('close');
  });
}

let conn: FakeConnection;

beforeEach(() => {
  conn = new FakeConnection();
  connectMock.mockReset();
  connectMock.mockResolvedValue(conn);
});

describe('connectRabbit', () => {
  it('registers connection listeners before the channel is created', async () => {
    await connectRabbit('amqp://x', { retryDelaysMs: [10] });
    expect(conn.listenersAtChannelCreation).toEqual({ error: 1, close: 1 });
  });

  it('reports an unexpected connection close and channel close/error via onClose', async () => {
    const onClose = vi.fn();
    await connectRabbit('amqp://x', { retryDelaysMs: [10], onClose });
    const err = new Error('boom');
    conn.emit('close', err);
    expect(onClose).toHaveBeenLastCalledWith(err);
    conn.channel.emit('error', new Error('channel error'));
    conn.channel.emit('close');
    expect(onClose).toHaveBeenCalledTimes(2); // 'error' is swallowed; the 'close' that follows reports
  });

  it('does not report an expected close()', async () => {
    const onClose = vi.fn();
    const rabbit = await connectRabbit('amqp://x', { retryDelaysMs: [10], onClose });
    await rabbit.close();
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes the connection and rethrows when topology assertion fails', async () => {
    const onClose = vi.fn();
    const failure = new Error('PRECONDITION_FAILED');
    conn.channel.assertQueue.mockRejectedValueOnce(failure);
    await expect(connectRabbit('amqp://x', { retryDelaysMs: [10], onClose })).rejects.toBe(failure);
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes the connection and rethrows when the channel cannot be created', async () => {
    const failure = new Error('channel limit');
    conn.createConfirmChannel.mockRejectedValueOnce(failure);
    await expect(connectRabbit('amqp://x', { retryDelaysMs: [10] })).rejects.toBe(failure);
    expect(conn.close).toHaveBeenCalledTimes(1);
  });
});
