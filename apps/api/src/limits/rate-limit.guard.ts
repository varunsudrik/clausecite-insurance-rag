import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AuthedRequest } from '../auth/auth.types.js';
import { LimitsService } from './limits.service.js';
import { RATE_POLICY_KEY, type RatePolicyName } from './policies.js';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(LimitsService) private readonly limits: LimitsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.get<RatePolicyName | undefined>(
      RATE_POLICY_KEY,
      ctx.getHandler(),
    );
    if (!policy) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const result = await this.limits.check(policy, req.user, req.ip ?? 'unknown');
    if (!result.allowed) {
      ctx
        .switchToHttp()
        .getResponse<Response>()
        .setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new HttpException(
        { message: 'Rate limit exceeded', retryAfterSeconds: result.retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
