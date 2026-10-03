import { INGEST_EXCHANGE, type DbHandle, type RabbitConnection } from '@clausecite/core';
import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Public } from '../common/public.decorator.js';
import { DATABASE, RABBIT, REDIS } from '../infra/tokens.js';

/** A dependency that has not answered within this long counts as down. */
export const HEALTH_PROBE_TIMEOUT_MS = 2000;

const logger = new Logger('Health');

/**
 * Resolves true if `fn` succeeds within the timeout. A rejection or a timeout is reported as
 * false; the reason is logged server-side only (the public body carries booleans, never errors).
 */
const probe = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${HEALTH_PROBE_TIMEOUT_MS}ms`)),
          HEALTH_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch (err) {
    logger.warn(`${name} probe failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    clearTimeout(timer);
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
    const [db, redis, rabbitmq] = await Promise.all([
      probe('db', () => this.database.pool.query('select 1')),
      probe('redis', () => this.redis.ping()),
      probe('rabbitmq', () => this.rabbit.channel.checkExchange(INGEST_EXCHANGE)),
    ]);
    const checks = { db, redis, rabbitmq };
    if (!Object.values(checks).every(Boolean)) {
      throw new ServiceUnavailableException({ status: 'degraded', checks });
    }
    return { status: 'ok', checks };
  }
}
