import { HttpException } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../infra/tokens.js';
import { LimitsService } from './limits.service.js';

let container: StartedRedisContainer;
let redis: Redis;
let limits: LimitsService;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
  limits = new LimitsService(redis, { GUEST_DAILY_TOKEN_BUDGET: 1000 } as ApiConfig);
});
afterAll(async () => {
  await redis?.quit();
  await container?.stop();
});

// 12:30:30 UTC is mid-window for every window we use (60 s, 900 s, 3600 s: 30 s, 30 s, 1830 s in),
// so loops of requests can never straddle a window boundary. Only Date is faked: ioredis timers stay real.
const T0 = Date.UTC(2030, 0, 1, 12, 30, 30);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const guest = (id: string) => ({ id, role: 'guest' as const });

describe('LimitsService', () => {
  it('allows 10 chat requests per guest per minute, then blocks with retry-after', async () => {
    for (let i = 0; i < 10; i++)
      expect((await limits.check('chat', guest('g1'), '1.1.1.1')).allowed).toBe(true);
    const blocked = await limits.check('chat', guest('g1'), '1.1.1.1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(30); // 30 s left in the current minute
  });

  it('starts a fresh count once the clock moves past the window', async () => {
    for (let i = 0; i < 10; i++) await limits.check('chat', guest('g-window'), '1.2.3.4');
    expect((await limits.check('chat', guest('g-window'), '1.2.3.4')).allowed).toBe(false);
    vi.setSystemTime(T0 + 60_000);
    expect((await limits.check('chat', guest('g-window'), '1.2.3.4')).allowed).toBe(true);
  });

  it('gives every window counter a TTL so keys expire on their own', async () => {
    await limits.check('chat', guest('g-ttl'), '1.3.5.7');
    const keys = await redis.keys('rl:chat:user:g-ttl:*');
    expect(keys).toHaveLength(1);
    const ttl = await redis.ttl(keys[0] as string);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(61); // windowSeconds + 1
  });

  it('caps an IP at 30/min across many guests', async () => {
    let allowed = 0;
    for (let i = 0; i < 35; i++)
      if ((await limits.check('search', guest(`ip-${i}`), '2.2.2.2')).allowed) allowed++;
    expect(allowed).toBe(30);
  });

  it('does not burn the shared IP quota with already-blocked guest requests', async () => {
    const hammer = guest('hammer');
    let hammered = 0;
    for (let i = 0; i < 25; i++)
      if ((await limits.check('chat', hammer, '7.7.7.7')).allowed) hammered++;
    expect(hammered).toBe(10);
    // Only the 10 allowed requests counted against the IP, so 30 - 10 = 20 remain for other guests.
    let others = 0;
    for (let g = 0; g < 3; g++)
      for (let i = 0; i < 10; i++)
        if ((await limits.check('chat', guest(`other-${g}`), '7.7.7.7')).allowed) others++;
    expect(others).toBe(20);
  });

  it('gives admins a higher per-user limit and no IP cap', async () => {
    const admin = { id: 'a1', role: 'admin' as const };
    let allowed = 0;
    for (let i = 0; i < 61; i++)
      if ((await limits.check('chat', admin, '3.3.3.3')).allowed) allowed++;
    expect(allowed).toBe(60);
  });

  it('limits guest token issuance to 5 per hour per IP', async () => {
    const results = [];
    for (let i = 0; i < 6; i++)
      results.push((await limits.check('guestToken', undefined, '4.4.4.4')).allowed);
    expect(results).toEqual([true, true, true, true, true, false]);
    expect((await limits.check('guestToken', undefined, '4.4.4.4')).retryAfterSeconds).toBe(1770);
  });

  it('limits login attempts to 10 per 15 minutes per IP, then blocks with retry-after', async () => {
    const results = [];
    for (let i = 0; i < 11; i++)
      results.push((await limits.check('login', undefined, '5.5.5.5')).allowed);
    expect(results).toEqual([...Array.from({ length: 10 }, () => true), false]);
    const blocked = await limits.check('login', undefined, '5.5.5.5');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(870); // 900 s window, 30 s in
    expect((await limits.check('login', undefined, '6.6.6.6')).allowed).toBe(true); // other IPs unaffected
  });

  it('enforces the daily guest token budget', async () => {
    const g = guest('budget-user');
    await limits.assertBudget(g);
    await limits.recordUsage(g, 1000);
    expect(await limits.usedToday('budget-user')).toBe(1000);
    const err = await limits.assertBudget(g).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    const body = (err as HttpException).getResponse() as { retryAfterSeconds: number };
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBe(41_370); // 11 h 29 m 30 s until UTC midnight
    await limits.assertBudget({ id: 'admin', role: 'admin' }); // admins unlimited
  });

  it('resets the guest budget on the next UTC day', async () => {
    const g = guest('budget-reset');
    await limits.recordUsage(g, 1000);
    await expect(limits.assertBudget(g)).rejects.toBeInstanceOf(HttpException);
    vi.setSystemTime(Date.UTC(2030, 0, 2, 0, 0, 1));
    expect(await limits.usedToday('budget-reset')).toBe(0);
    await limits.assertBudget(g);
  });
});
