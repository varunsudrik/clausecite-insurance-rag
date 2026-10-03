import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { LimitsModule } from './limits/limits.module.js';

@Module({
  imports: [InfraModule, LimitsModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
