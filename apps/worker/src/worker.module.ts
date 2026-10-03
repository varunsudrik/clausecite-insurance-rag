import {
  connectRabbit,
  createDb,
  dbEnv,
  llmEnv,
  loadEnv,
  rabbitEnv,
  storageEnv,
} from '@clausecite/core';
import { Module } from '@nestjs/common';
import { DATABASE, IngestWorker, RABBIT, WORKER_ENV, type WorkerEnv } from './ingest.worker.js';

@Module({
  providers: [
    {
      provide: WORKER_ENV,
      useFactory: (): WorkerEnv => ({
        ...loadEnv(dbEnv),
        ...loadEnv(llmEnv),
        ...loadEnv(rabbitEnv),
        ...loadEnv(storageEnv),
      }),
    },
    {
      provide: DATABASE,
      inject: [WORKER_ENV],
      useFactory: (env: WorkerEnv) => createDb(env.DATABASE_URL, 5),
    },
    {
      provide: RABBIT,
      inject: [WORKER_ENV],
      useFactory: (env: WorkerEnv) =>
        connectRabbit(env.RABBITMQ_URL, {
          retryDelaysMs: env.INGEST_RETRY_DELAYS_MS,
          onClose: () => {
            console.error(
              'RabbitMQ connection closed; exiting so the supervisor restarts the worker',
            );
            process.exit(1);
          },
        }),
    },
    IngestWorker,
  ],
})
export class WorkerModule {}
