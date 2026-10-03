import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';

@Module({
  imports: [InfraModule],
  controllers: [HealthController],
})
export class AppModule {}
