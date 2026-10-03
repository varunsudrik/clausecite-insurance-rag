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

  /** `ip` is a bucket key from `clientIpKey` (IPv4, or an IPv6 /64), not a raw address. */
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

  /** A counter's value; a stored value that is not a number must fail closed, never read as 0. */
  private async counter(key: string): Promise<number> {
    const used = Number((await this.redis.get(key)) ?? 0);
    if (!Number.isFinite(used)) throw new Error(`Budget counter ${key} holds a non-numeric value`);
    return used;
  }

  private globalKey = () => `budget:global:${utcDay()}`;

  async usedToday(userId: string): Promise<number> {
    return this.counter(`budget:${userId}:${utcDay()}`);
  }

  /**
   * Throws 429 once the whole deployment (every role) has spent GLOBAL_DAILY_TOKEN_BUDGET today, or,
   * for guests, once that guest has spent GUEST_DAILY_TOKEN_BUDGET. A Redis failure rejects the request.
   */
  async assertBudget(user: AuthUser): Promise<void> {
    if ((await this.counter(this.globalKey())) >= this.env.GLOBAL_DAILY_TOKEN_BUDGET) {
      throw new HttpException(
        { message: 'Service daily budget exhausted', retryAfterSeconds: secondsUntilUtcMidnight() },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (user.role === 'admin') return;
    if ((await this.usedToday(user.id)) >= this.env.GUEST_DAILY_TOKEN_BUDGET) {
      throw new HttpException(
        { message: 'Daily token budget exhausted', retryAfterSeconds: secondsUntilUtcMidnight() },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Adds to the global counter for every role, and to the per-user counter for guests only. */
  async recordUsage(user: AuthUser, tokens: number): Promise<void> {
    if (!Number.isFinite(tokens)) return;
    const amount = Math.round(tokens);
    if (amount <= 0) return;
    const ttl = 2 * 24 * 3600;
    const globalKey = this.globalKey();
    const multi = this.redis.multi().incrby(globalKey, amount).expire(globalKey, ttl);
    if (user.role !== 'admin') {
      const key = `budget:${user.id}:${utcDay()}`;
      multi.incrby(key, amount).expire(key, ttl);
    }
    execResults(await multi.exec());
  }

  /** The nominal charge for a retrieval (query embedding + rerank), which records no model usage itself. */
  chargeSearch(user: AuthUser): Promise<void> {
    return this.recordUsage(user, this.env.SEARCH_TOKEN_COST);
  }
}
