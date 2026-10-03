import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AuthUser } from '../auth/auth.types.js';
import { API_ENV, REDIS, type ApiConfig } from '../infra/tokens.js';
import { RATE_POLICIES, type RatePolicyName, type Window } from './policies.js';

export interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const utcDay = () => new Date().toISOString().slice(0, 10);
const secondsUntilUtcMidnight = () => {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((midnight - now.getTime()) / 1000);
};

@Injectable()
export class LimitsService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_ENV) private readonly env: ApiConfig,
  ) {}

  /** Fixed-window counter: INCR the current bucket; EXPIRE NX arms the TTL once per bucket. */
  private async hit(key: string, w: Window): Promise<LimitResult> {
    const nowS = Math.floor(Date.now() / 1000);
    const bucketKey = `rl:${key}:${Math.floor(nowS / w.windowSeconds)}`;
    const replies = await this.redis
      .multi()
      .incr(bucketKey)
      .expire(bucketKey, w.windowSeconds + 1, 'NX')
      .exec();
    const count = Number(replies?.[0]?.[1] ?? 0);
    return {
      allowed: count <= w.limit,
      retryAfterSeconds: w.windowSeconds - (nowS % w.windowSeconds),
    };
  }

  async check(
    policy: RatePolicyName,
    user: AuthUser | undefined,
    ip: string,
  ): Promise<LimitResult> {
    const results: LimitResult[] = [];
    if (policy === 'guestToken' || policy === 'login') {
      // Unauthenticated endpoints: keyed by IP only.
      results.push(await this.hit(`${policy}:ip:${ip}`, RATE_POLICIES[policy].ip));
    } else {
      const p = RATE_POLICIES[policy];
      if (user?.role === 'admin') {
        results.push(await this.hit(`${policy}:user:${user.id}`, p.adminUser));
      } else {
        results.push(await this.hit(`${policy}:user:${user?.id ?? 'anon'}`, p.guestUser));
        results.push(await this.hit(`${policy}:ip:${ip}`, p.ip));
      }
    }
    const blocked = results.filter((r) => !r.allowed);
    return blocked.length
      ? { allowed: false, retryAfterSeconds: Math.max(...blocked.map((r) => r.retryAfterSeconds)) }
      : { allowed: true, retryAfterSeconds: 0 };
  }

  async usedToday(userId: string): Promise<number> {
    return Number((await this.redis.get(`budget:${userId}:${utcDay()}`)) ?? 0);
  }

  async assertBudget(user: AuthUser): Promise<void> {
    if (user.role === 'admin') return;
    if ((await this.usedToday(user.id)) >= this.env.GUEST_DAILY_TOKEN_BUDGET) {
      throw new HttpException(
        { message: 'Daily token budget exhausted', retryAfterSeconds: secondsUntilUtcMidnight() },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async recordUsage(user: AuthUser, tokens: number): Promise<void> {
    if (user.role === 'admin' || tokens <= 0) return;
    const key = `budget:${user.id}:${utcDay()}`;
    await this.redis
      .multi()
      .incrby(key, Math.round(tokens))
      .expire(key, 2 * 24 * 3600)
      .exec();
  }
}
