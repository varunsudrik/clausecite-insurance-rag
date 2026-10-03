import { INGEST_EXCHANGE, type DbHandle, type RabbitConnection } from '@clausecite/core';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Public } from '../common/public.decorator.js';
import { DATABASE, RABBIT, REDIS } from '../infra/tokens.js';

const probe = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
};

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(RABBIT) private readonly rabbit: RabbitConnection,
  ) {}

  @Public()
  @Get()
  async check() {
    const checks = {
      db: await probe(() => this.database.pool.query('select 1')),
      redis: await probe(() => this.redis.ping()),
      rabbitmq: await probe(() => this.rabbit.channel.checkExchange(INGEST_EXCHANGE)),
    };
    if (!Object.values(checks).every(Boolean)) {
      throw new ServiceUnavailableException({ status: 'degraded', checks });
    }
    return { status: 'ok', checks };
  }
}
