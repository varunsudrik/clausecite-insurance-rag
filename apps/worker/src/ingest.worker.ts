import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createModels,
  describeError,
  ingestDocument,
  type DbEnv,
  type DbHandle,
  type LlmEnv,
  type Models,
  type RabbitConnection,
  type RabbitEnv,
  type StorageEnv,
} from '@clausecite/core';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { IngestConsumer } from './ingest.consumer.js';

export type WorkerEnv = DbEnv & LlmEnv & RabbitEnv & StorageEnv;
export const WORKER_ENV = Symbol('WORKER_ENV');
export const DATABASE = Symbol('DATABASE');
export const RABBIT = Symbol('RABBIT');
/** Optional override of the models the worker builds from env; the composition test injects mocks. */
export const WORKER_MODELS = Symbol('WORKER_MODELS');
/** The only models ingestion needs (a full `Models` satisfies this). */
export type WorkerModels = Pick<Models, 'embedding'> & { ids: Pick<Models['ids'], 'embedding'> };

@Injectable()
export class IngestWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('IngestWorker');
  private consumer?: IngestConsumer;

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(RABBIT) private readonly rabbit: RabbitConnection,
    @Optional() @Inject(WORKER_MODELS) private readonly models?: WorkerModels,
  ) {}

  async onApplicationBootstrap() {
    const models: WorkerModels = this.models ?? createModels(this.env);
    this.consumer = new IngestConsumer({
      channel: this.rabbit.channel,
      db: this.database.db,
      retryDelaysMs: this.env.INGEST_RETRY_DELAYS_MS,
      logger: this.logger,
      onFatal: (reason, err) => {
        this.logger.error(
          `${reason}${err ? `: ${describeError(err)}` : ''}; exiting so the supervisor restarts the worker`,
        );
        process.exit(1);
      },
      ingest: (id) =>
        ingestDocument(
          {
            db: this.database.db,
            embeddingModel: models.embedding,
            embeddingModelId: models.ids.embedding,
            logger: this.logger,
            readFile: async (name) =>
              new Uint8Array(await readFile(resolve(this.env.STORAGE_DIR, name))),
          },
          id,
        ),
    });
    await this.consumer.start();
    this.logger.log('consuming ingest.document');
  }

  async onApplicationShutdown() {
    try {
      // let in-flight jobs finish and be acked before the channel and pool go away
      await this.consumer?.stop();
    } finally {
      await this.rabbit.close();
      await this.database.pool.end();
    }
  }
}
