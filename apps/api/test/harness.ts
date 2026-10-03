import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db, Models, RabbitConnection, Reranker } from '@clausecite/core';
import {
  fakeReranker,
  mockChatModel,
  mockEmbeddingModel,
  startTestDb,
} from '@clausecite/core/testing';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer } from '@testcontainers/redis';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { MODELS, RABBIT, REDIS, RERANKER } from '../src/infra/tokens.js';

export interface Harness {
  app: INestApplication;
  http: ReturnType<typeof request>;
  db: Db;
  redis: Redis;
  rabbit: RabbitConnection;
  storageDir: string;
  stop(): Promise<void>;
}

/** Scores a document by the fraction of query words (exact word match) it contains. */
export const wordOverlapReranker = (): Reranker =>
  fakeReranker((q, d) => {
    const words = q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const docWords = new Set(d.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    return words.length ? words.filter((w) => docWords.has(w)).length / words.length : 0;
  });

export async function startHarness(
  opts: { models?: Partial<Models>; reranker?: Reranker; env?: Record<string, string> } = {},
): Promise<Harness> {
  const started = await Promise.allSettled([
    startTestDb(),
    new RedisContainer('redis:7-alpine').start(),
    new RabbitMQContainer('rabbitmq:3.13-management').start(),
  ]);
  const [pgResult, redisResult, mqResult] = started;
  if (
    pgResult.status !== 'fulfilled' ||
    redisResult.status !== 'fulfilled' ||
    mqResult.status !== 'fulfilled'
  ) {
    // One failed: do not leak the ones that did start.
    await Promise.allSettled(
      started.map((r) => (r.status === 'fulfilled' ? r.value.stop() : null)),
    );
    throw started.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
  }
  const pg = pgResult.value;
  const redisC = redisResult.value;
  const mq = mqResult.value;

  let app: INestApplication | undefined;
  let moduleRef: TestingModule | undefined;
  let storageDir: string | undefined;
  // Always runs to the end: containers and the temp dir are released even if closing the app throws.
  // Cleanup failures of the containers themselves are best-effort (testcontainers' reaper is the net).
  const teardown = async () => {
    try {
      await (app ?? moduleRef)?.close();
    } finally {
      await Promise.allSettled([
        pg.stop(),
        redisC.stop(),
        mq.stop(),
        storageDir ? rm(storageDir, { recursive: true, force: true }) : null,
      ]);
    }
  };

  try {
    storageDir = await mkdtemp(join(tmpdir(), 'clausecite-'));
    Object.assign(process.env, {
      DATABASE_URL: pg.url,
      REDIS_URL: redisC.getConnectionUrl(),
      RABBITMQ_URL: mq.getAmqpUrl(),
      STORAGE_DIR: storageDir,
      OPENROUTER_API_KEY: 'test-key',
      JWT_SECRET: 'x'.repeat(40),
      ADMIN_EMAIL: 'admin@test.local',
      ADMIN_PASSWORD: 'admin-pass-123',
      API_KEY: 'test-api-key',
      WEB_ORIGIN: 'http://localhost:3000',
      ...opts.env,
    });
    const models: Models = {
      chat: mockChatModel({}),
      rewrite: mockChatModel({}),
      embedding: mockEmbeddingModel(),
      ids: { chat: 'mock-chat', embedding: 'mock-embedding', rerank: 'mock-rerank' },
      ...opts.models,
    };
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MODELS)
      .useValue(models)
      .overrideProvider(RERANKER)
      .useValue(opts.reranker ?? wordOverlapReranker())
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    const ready = app;
    return {
      app: ready,
      http: request(ready.getHttpServer()),
      db: pg.db,
      redis: ready.get(REDIS),
      rabbit: ready.get(RABBIT),
      storageDir,
      stop: teardown,
    };
  } catch (err) {
    await teardown().catch(() => undefined);
    throw err;
  }
}
