import { HttpException } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../infra/tokens.js';
import { clientIpKey } from './client-ip.js';
import { LimitsService } from './limits.service.js';

let container: StartedRedisContainer;
let redis: Redis;
let limits: LimitsService;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
  limits = new LimitsService(redis, {
    GUEST_DAILY_TOKEN_BUDGET: 1000,
    GLOBAL_DAILY_TOKEN_BUDGET: 1_000_000,
    SEARCH_TOKEN_COST: 300,
  } as ApiConfig);
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
const admin = (id: string) => ({ id, role: 'admin' as const });
const globalKey = (day = '2030-01-01') => `budget:global:${day}`;
const globalUsed = async (day?: string) => Number((await redis.get(globalKey(day))) ?? 0);

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
    const a1 = admin('a1');
    let allowed = 0;
    for (let i = 0; i < 61; i++) if ((await limits.check('chat', a1, '3.3.3.3')).allowed) allowed++;
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

describe('LimitsService IP buckets', () => {
  it('counts two IPv6 clients of one /64 against the same IP bucket', async () => {
    let allowed = 0;
    for (let i = 0; i < 35; i++) {
      const ip = clientIpKey(`2001:db8:aa:bb:${(i + 1).toString(16)}::1`);
      if ((await limits.check('search', guest(`v6-${i}`), ip)).allowed) allowed++;
    }
    expect(allowed).toBe(30);
  });

  it('keeps different /64s in separate IP buckets', async () => {
    for (let i = 0; i < 30; i++)
      await limits.check('search', guest(`v6a-${i}`), clientIpKey('2001:db8:cc:1::1'));
    const other = await limits.check('search', guest('v6b'), clientIpKey('2001:db8:cc:2::1'));
    expect(other.allowed).toBe(true);
  });
});

describe('global daily budget (DECISIONS 012)', () => {
  const globalLimits = (budget: number) =>
    new LimitsService(redis, {
      GUEST_DAILY_TOKEN_BUDGET: 1_000_000,
      GLOBAL_DAILY_TOKEN_BUDGET: budget,
      SEARCH_TOKEN_COST: 300,
    } as ApiConfig);

  beforeEach(async () => {
    await redis.del(globalKey(), globalKey('2030-01-02'));
  });

  it('blocks everyone, admins included, once guests and admins together spend the cap', async () => {
    const capped = globalLimits(1000);
    await capped.recordUsage(guest('cap-a'), 600);
    await capped.assertBudget(guest('cap-c')); // 600 < 1000: still open
    await capped.recordUsage(admin('cap-b'), 400);
    expect(await globalUsed()).toBe(1000);

    for (const user of [guest('cap-c'), admin('cap-b')]) {
      const err = await capped.assertBudget(user).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
      expect((err as HttpException).getResponse()).toMatchObject({
        message: 'Service daily budget exhausted',
        retryAfterSeconds: 41_370, // 11 h 29 m 30 s until UTC midnight
      });
    }
  });

  it('reports the global message even when the guest still has personal budget left', async () => {
    const capped = globalLimits(100);
    await capped.recordUsage(guest('cap-d'), 100);
    const err = await capped.assertBudget(guest('cap-d')).catch((e) => e);
    expect((err as HttpException).getResponse()).toMatchObject({
      message: 'Service daily budget exhausted',
    });
  });

  it('keeps the per-guest message when only the guest is over its own budget', async () => {
    const g = guest('own-budget');
    await limits.recordUsage(g, 1000);
    const err = await limits.assertBudget(g).catch((e) => e);
    expect((err as HttpException).getResponse()).toMatchObject({
      message: 'Daily token budget exhausted',
    });
  });

  it('resets on the next UTC day', async () => {
    const capped = globalLimits(1000);
    await capped.recordUsage(guest('cap-e'), 1000);
    await expect(capped.assertBudget(guest('cap-f'))).rejects.toBeInstanceOf(HttpException);
    vi.setSystemTime(Date.UTC(2030, 0, 2, 0, 0, 1));
    await capped.assertBudget(guest('cap-f'));
    await capped.assertBudget(admin('cap-g'));
  });

  it('gives the global counter a TTL so the key expires on its own', async () => {
    await limits.recordUsage(guest('ttl-g'), 10);
    const ttl = await redis.ttl(globalKey());
    expect(ttl).toBeGreaterThan(24 * 3600);
    expect(ttl).toBeLessThanOrEqual(2 * 24 * 3600);
  });

  it('counts admin usage on the global key but not on a per-user key', async () => {
    await limits.recordUsage(admin('adm-usage'), 250);
    expect(await globalUsed()).toBe(250);
    expect(await redis.keys('budget:adm-usage:*')).toEqual([]);
    expect(await limits.usedToday('adm-usage')).toBe(0);
  });

  it('counts guest usage on both the global and the per-guest key', async () => {
    await limits.recordUsage(guest('gst-usage'), 125);
    expect(await globalUsed()).toBe(125);
    expect(await limits.usedToday('gst-usage')).toBe(125);
  });

  it('chargeSearch adds SEARCH_TOKEN_COST to both the global and the guest keys', async () => {
    await limits.chargeSearch(guest('charge-g'));
    await limits.chargeSearch(guest('charge-g'));
    expect(await globalUsed()).toBe(600);
    expect(await limits.usedToday('charge-g')).toBe(600);
  });

  it('chargeSearch charges an admin to the global key only', async () => {
    await limits.chargeSearch(admin('charge-a'));
    expect(await globalUsed()).toBe(300);
    expect(await limits.usedToday('charge-a')).toBe(0);
  });

  it('nominal charges alone eventually trip the cap (search spam is no longer free)', async () => {
    const capped = globalLimits(900);
    for (let i = 0; i < 3; i++) {
      await capped.assertBudget(guest('spam'));
      await capped.chargeSearch(guest('spam'));
    }
    await expect(capped.assertBudget(guest('spam'))).rejects.toMatchObject({ status: 429 });
  });

  it('fails closed when the global counter is not a number', async () => {
    await redis.set(globalKey(), 'garbage');
    await expect(limits.assertBudget(guest('garbled'))).rejects.toThrow();
    await expect(limits.assertBudget(admin('garbled-admin'))).rejects.toThrow();
  });
});
