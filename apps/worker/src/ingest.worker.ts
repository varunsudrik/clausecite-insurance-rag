import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createModels,
  ingestDocument,
  type DbEnv,
  type DbHandle,
  type LlmEnv,
  type RabbitConnection,
  type RabbitEnv,
  type StorageEnv,
} from '@clausecite/core';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { IngestConsumer } from './ingest.consumer.js';

export type WorkerEnv = DbEnv & LlmEnv & RabbitEnv & StorageEnv;
export const WORKER_ENV = Symbol('WORKER_ENV');
export const DATABASE = Symbol('DATABASE');
export const RABBIT = Symbol('RABBIT');

@Injectable()
export class IngestWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('IngestWorker');
  private consumer?: IngestConsumer;

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(RABBIT) private readonly rabbit: RabbitConnection,
  ) {}

  async onApplicationBootstrap() {
    const models = createModels(this.env);
    this.consumer = new IngestConsumer({
      channel: this.rabbit.channel,
      db: this.database.db,
      retryDelaysMs: this.env.INGEST_RETRY_DELAYS_MS,
      logger: this.logger,
      ingest: (id) =>
        ingestDocument(
          {
            db: this.database.db,
            embeddingModel: models.embedding,
            embeddingModelId: models.ids.embedding,
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
    await this.consumer?.stop();
    await this.rabbit.close();
    await this.database.pool.end();
  }
}
