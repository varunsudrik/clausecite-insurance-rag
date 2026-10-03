import { Global, Module } from '@nestjs/common';
import { LimitsService } from './limits.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';

@Global()
@Module({ providers: [LimitsService, RateLimitGuard], exports: [LimitsService, RateLimitGuard] })
export class LimitsModule {}
