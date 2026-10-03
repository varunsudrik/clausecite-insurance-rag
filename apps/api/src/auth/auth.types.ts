import type { UserRole } from '@clausecite/core';
import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthUser {
  id: string;
  role: UserRole;
}

export type AuthedRequest = Request & { user?: AuthUser };

export const ROLES_KEY = 'clausecite:roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user,
);
