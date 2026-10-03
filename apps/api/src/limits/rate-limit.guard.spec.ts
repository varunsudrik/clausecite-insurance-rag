import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { LimitResult, LimitsService } from './limits.service.js';
import { RateLimit } from './policies.js';
import { RateLimitGuard } from './rate-limit.guard.js';

@RateLimit('search')
class ClassPolicyRoutes {
  inherits() {}
  @RateLimit('chat') overrides() {}
}
class Routes {
  @RateLimit('guestToken') limited() {}
  unconfigured() {}
}

const user = { id: 'u1', role: 'guest' as const };

function setup(result: LimitResult = { allowed: true, retryAfterSeconds: 0 }) {
  const check = vi.fn(async () => result);
  const guard = new RateLimitGuard(new Reflector(), { check } as unknown as LimitsService);
  const ctx = (cls: new () => object, method: string) =>
    ({
      getHandler: () => (cls.prototype as Record<string, () => void>)[method],
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ user, ip: '1.2.3.4' }) }),
    }) as unknown as ExecutionContext;
  return { guard, check, ctx };
}

describe('RateLimitGuard', () => {
  it('checks the handler policy with the request user and ip', async () => {
    const { guard, check, ctx } = setup();
    expect(await guard.canActivate(ctx(Routes, 'limited'))).toBe(true);
    expect(check).toHaveBeenCalledWith('guestToken', user, '1.2.3.4');
  });

  it('throws 429 with retryAfterSeconds in the body when blocked', async () => {
    const { guard, ctx } = setup({ allowed: false, retryAfterSeconds: 17 });
    const err = await guard.canActivate(ctx(Routes, 'limited')).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ retryAfterSeconds: 17 });
  });

  it('falls back to a class-level policy and lets a handler policy override it', async () => {
    const { guard, check, ctx } = setup();
    await guard.canActivate(ctx(ClassPolicyRoutes, 'inherits'));
    expect(check).toHaveBeenLastCalledWith('search', user, '1.2.3.4');
    await guard.canActivate(ctx(ClassPolicyRoutes, 'overrides'));
    expect(check).toHaveBeenLastCalledWith('chat', user, '1.2.3.4');
  });

  it('throws when applied without a @RateLimit policy instead of silently disabling limiting', async () => {
    const { guard, check, ctx } = setup();
    await expect(guard.canActivate(ctx(Routes, 'unconfigured'))).rejects.toThrow(/@RateLimit/);
    expect(check).not.toHaveBeenCalled();
  });
});
