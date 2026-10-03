import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { TooManyRequestsFilter } from './common/too-many-requests.filter.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { LimitsModule } from './limits/limits.module.js';

@Module({
  imports: [InfraModule, LimitsModule, AuthModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: TooManyRequestsFilter }],
})
export class AppModule {}
