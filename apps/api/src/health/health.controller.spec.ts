import type { DbHandle, RabbitConnection } from '@clausecite/core';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_PROBE_TIMEOUT_MS, HealthController } from './health.controller.js';

const never = () => new Promise<never>(() => undefined);

const makeController = (fakes: {
  query?: () => Promise<unknown>;
  ping?: () => Promise<unknown>;
  checkExchange?: () => Promise<unknown>;
}) =>
  new HealthController(
    { pool: { query: fakes.query ?? (async () => ({ rows: [] })) } } as unknown as DbHandle,
    { ping: fakes.ping ?? (async () => 'PONG') } as unknown as Redis,
    {
      channel: { checkExchange: fakes.checkExchange ?? (async () => ({})) },
    } as unknown as RabbitConnection,
  );

/** Runs check() and returns whatever it settles with (resolved value or thrown error). */
const settle = (controller: HealthController) =>
  controller.check().then(
    (value) => ({ value }) as const,
    (error: unknown) => ({ error }) as const,
  );

describe('HealthController', () => {
  const warn = vi.fn<(message: unknown) => void>();
  beforeEach(() => {
    vi.useFakeTimers();
    warn.mockClear();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(warn);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports ok when every dependency answers', async () => {
    const outcome = await settle(makeController({}));
    expect(outcome).toEqual({
      value: { status: 'ok', checks: { db: true, redis: true, rabbitmq: true } },
    });
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // probe timeouts are cleared once the probes settle
  });

  it('degrades within the probe timeout when redis rejects and rabbit never answers', async () => {
    const controller = makeController({
      ping: async () => {
        throw new Error('redis down');
      },
      checkExchange: never,
    });
    let outcome: Awaited<ReturnType<typeof settle>> | undefined;
    void settle(controller).then((o) => (outcome = o));

    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined(); // still waiting on the hung rabbit probe
    await vi.advanceTimersByTimeAsync(1);

    expect(HEALTH_PROBE_TIMEOUT_MS).toBeLessThan(3000);
    expect(outcome).toBeDefined();
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'degraded',
      checks: { db: true, redis: false, rabbitmq: false },
    });
    // failure reasons are logged server-side, never put in the public body
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('redis');
    expect(logged).toContain('redis down');
    expect(logged).toContain('rabbitmq');
  });

  it('probes concurrently: three hung dependencies cost one timeout, not three', async () => {
    const controller = makeController({ query: never, ping: never, checkExchange: never });
    let outcome: Awaited<ReturnType<typeof settle>> | undefined;
    void settle(controller).then((o) => (outcome = o));

    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS);

    const error = (outcome as { error: unknown } | undefined)?.error;
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'degraded',
      checks: { db: false, redis: false, rabbitmq: false },
    });
  });
});
