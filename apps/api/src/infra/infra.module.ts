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

@Injectable()
class InfraLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(RABBIT) private readonly rabbit: RabbitConnection,
  ) {}
  async onApplicationShutdown() {
    await this.rabbit.close();
    await this.redis.quit().catch(() => undefined);
    await this.database.pool.end();
  }
}

const logger = new Logger('Infra');

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
      useFactory: (env: ApiConfig) => new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 }),
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
