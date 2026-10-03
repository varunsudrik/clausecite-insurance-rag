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

/** Returns each command's result, throwing if EXEC was aborted or any queued command failed. */
const execResults = (replies: [Error | null, unknown][] | null): unknown[] => {
  if (!replies) throw new Error('Redis EXEC was aborted (null reply)');
  return replies.map(([err, result]) => {
    if (err) throw err;
    return result;
  });
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
    const count = Number(execResults(replies)[0]);
    // Fail closed: a reply we cannot read as a count must never be mistaken for "0 hits".
    if (!Number.isFinite(count)) throw new Error(`Rate limiter: unreadable INCR reply for ${key}`);
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
    if (policy === 'guestToken' || policy === 'login') {
      // Unauthenticated endpoints: keyed by IP only.
      return this.verdict(await this.hit(`${policy}:ip:${ip}`, RATE_POLICIES[policy].ip));
    }
    const p = RATE_POLICIES[policy];
    if (user?.role === 'admin') {
      return this.verdict(await this.hit(`${policy}:user:${user.id}`, p.adminUser));
    }
    // Guests: user bucket first, and only requests it lets through count against the shared IP
    // bucket, so one guest hammering past its own limit cannot exhaust the IP quota for others.
    const perUser = await this.hit(`${policy}:user:${user?.id ?? 'anon'}`, p.guestUser);
    if (!perUser.allowed) return this.verdict(perUser);
    return this.verdict(await this.hit(`${policy}:ip:${ip}`, p.ip));
  }

  private verdict(r: LimitResult): LimitResult {
    return r.allowed ? { allowed: true, retryAfterSeconds: 0 } : r;
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
    if (user.role === 'admin' || !Number.isFinite(tokens)) return;
    const amount = Math.round(tokens);
    if (amount <= 0) return;
    const key = `budget:${user.id}:${utcDay()}`;
    execResults(
      await this.redis
        .multi()
        .incrby(key, amount)
        .expire(key, 2 * 24 * 3600)
        .exec(),
    );
  }
}
