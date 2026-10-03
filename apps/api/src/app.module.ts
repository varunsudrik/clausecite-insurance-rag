import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';

@Module({
  imports: [InfraModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
