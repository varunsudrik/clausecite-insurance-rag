import { HttpException } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const guest = (id: string) => ({ id, role: 'guest' as const });

describe('LimitsService', () => {
  it('allows 10 chat requests per guest per minute, then blocks with retry-after', async () => {
    for (let i = 0; i < 10; i++)
      expect((await limits.check('chat', guest('g1'), '1.1.1.1')).allowed).toBe(true);
    const blocked = await limits.check('chat', guest('g1'), '1.1.1.1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('caps an IP at 30/min across many guests', async () => {
    let allowed = 0;
    for (let i = 0; i < 35; i++)
      if ((await limits.check('search', guest(`ip-${i}`), '2.2.2.2')).allowed) allowed++;
    expect(allowed).toBe(30);
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
  });

  it('limits login attempts to 10 per 15 minutes per IP, then blocks with retry-after', async () => {
    const results = [];
    for (let i = 0; i < 11; i++)
      results.push((await limits.check('login', undefined, '5.5.5.5')).allowed);
    expect(results).toEqual([...Array.from({ length: 10 }, () => true), false]);
    const blocked = await limits.check('login', undefined, '5.5.5.5');
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(900);
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
    await limits.assertBudget({ id: 'admin', role: 'admin' }); // admins unlimited
  });
});
