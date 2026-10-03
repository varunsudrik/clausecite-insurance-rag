import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthedRequest } from '../auth/auth.types.js';
import { LimitsService } from './limits.service.js';
import { RATE_POLICY_KEY, type RatePolicyName } from './policies.js';

/**
 * Throws 429 `{ message, retryAfterSeconds }`; the global TooManyRequestsFilter adds the
 * `Retry-After` header. Must be paired with `@RateLimit(policy)`.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(LimitsService) private readonly limits: LimitsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RatePolicyName | undefined>(RATE_POLICY_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!policy) {
      // Misconfiguration must be loud: silently skipping would leave the route unlimited.
      throw new Error(
        `RateLimitGuard applied to ${ctx.getClass().name}.${ctx.getHandler().name} without a @RateLimit(policy)`,
      );
    }
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const result = await this.limits.check(policy, req.user, req.ip ?? 'unknown');
    if (!result.allowed) {
      throw new HttpException(
        { message: 'Rate limit exceeded', retryAfterSeconds: result.retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
