import {
  apiEnv,
  authEnv,
  connectRabbit,
  createDb,
  createModels,
  createOpenRouterReranker,
  dbEnv,
  llmEnv,
  loadEnv,
  rabbitEnv,
  redisEnv,
  retrievalEnv,
  storageEnv,
  type DbHandle,
  type RabbitConnection,
} from '@clausecite/core';
import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { API_ENV, DATABASE, MODELS, RABBIT, REDIS, RERANKER, type ApiConfig } from './tokens.js';

const logger = new Logger('Infra');

@Injectable()
class InfraLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(RABBIT) private readonly rabbit: RabbitConnection,
  ) {}
  async onApplicationShutdown() {
    // Concurrent and independent: one slow or failing dependency must not keep the others open.
    const results = await Promise.allSettled([
      this.rabbit.close(),
      this.redis.quit().catch(() => this.redis.disconnect()),
      this.database.pool.end(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn(
          `shutdown: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
        );
      }
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: API_ENV,
      useFactory: (): ApiConfig => ({
        ...loadEnv(dbEnv),
        ...loadEnv(llmEnv),
        ...loadEnv(rabbitEnv),
        ...loadEnv(redisEnv),
        ...loadEnv(authEnv),
        ...loadEnv(storageEnv),
        ...loadEnv(retrievalEnv),
        ...loadEnv(apiEnv),
      }),
    },
    {
      provide: DATABASE,
      inject: [API_ENV],
      useFactory: (env: ApiConfig) => createDb(env.DATABASE_URL),
    },
    {
      provide: REDIS,
      inject: [API_ENV],
      useFactory: (env: ApiConfig) => {
        const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, commandTimeout: 5000 });
        // ioredis keeps retrying on its own; without a listener each failure is printed as an
        // "Unhandled error event".
        redis.on('error', (err: Error) => logger.warn(`redis error: ${err.message}`));
        return redis;
      },
    },
    {
      provide: RABBIT,
      inject: [API_ENV],
      useFactory: (env: ApiConfig) =>
        connectRabbit(env.RABBITMQ_URL, {
          retryDelaysMs: env.INGEST_RETRY_DELAYS_MS,
          onClose: () => {
            logger.error('RabbitMQ connection closed; exiting so the supervisor restarts the API');
            process.exit(1);
          },
        }),
    },
    { provide: MODELS, inject: [API_ENV], useFactory: (env: ApiConfig) => createModels(env) },
    {
      provide: RERANKER,
      inject: [API_ENV],
      useFactory: (env: ApiConfig) =>
        createOpenRouterReranker({
          apiKey: env.OPENROUTER_API_KEY,
          model: env.RERANK_MODEL,
          baseURL: env.OPENROUTER_BASE_URL,
        }),
    },
    InfraLifecycle,
  ],
  exports: [API_ENV, DATABASE, REDIS, RABBIT, MODELS, RERANKER],
})
export class InfraModule {}
