import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { Public } from '../common/public.decorator.js';
import { AuthGuard } from './auth.guard.js';
import type { AuthService } from './auth.service.js';
import { Roles, type AuthUser } from './auth.types.js';

class Routes {
  @Public() open() {}
  closed() {}
  @Roles('admin') adminOnly() {}
}

const users: Record<string, AuthUser> = {
  g: { id: 'u1', role: 'guest' },
  a: { id: 'u2', role: 'admin' },
};
const auth = {
  verify: async (t: string) => {
    if (!users[t]) throw new UnauthorizedException();
    return users[t];
  },
} as unknown as AuthService;

const ctx = (method: keyof Routes, authorization?: string) => {
  const req: Record<string, unknown> = { headers: authorization ? { authorization } : {} };
  return {
    req,
    context: {
      getHandler: () => Routes.prototype[method],
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext,
  };
};

const guard = new AuthGuard(new Reflector(), auth);

describe('AuthGuard', () => {
  it('lets public routes through without a token', async () => {
    expect(await guard.canActivate(ctx('open').context)).toBe(true);
  });
  it('rejects missing or invalid tokens', async () => {
    await expect(guard.canActivate(ctx('closed').context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(ctx('closed', 'Bearer nope').context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
  it('attaches the user and enforces roles', async () => {
    const ok = ctx('closed', 'Bearer g');
    expect(await guard.canActivate(ok.context)).toBe(true);
    expect(ok.req.user).toEqual(users.g);
    await expect(guard.canActivate(ctx('adminOnly', 'Bearer g').context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(await guard.canActivate(ctx('adminOnly', 'Bearer a').context)).toBe(true);
  });
});
