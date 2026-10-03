import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectRabbit,
  type Db,
  type Models,
  type RabbitConnection,
  type Reranker,
} from '@clausecite/core';
import {
  fakeReranker,
  mockChatModel,
  mockEmbeddingModel,
  startTestDb,
} from '@clausecite/core/testing';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer } from '@testcontainers/redis';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import type { RabbitPublisher } from '../src/infra/rabbit-publisher.js';
import { API_ENV, MODELS, RABBIT, REDIS, RERANKER, type ApiConfig } from '../src/infra/tokens.js';

export interface Harness {
  app: INestApplication;
  http: ReturnType<typeof request>;
  db: Db;
  redis: Redis;
  /** The app's own (lazy, reconnecting) publisher: what the API publishes through. */
  rabbit: RabbitPublisher;
  /** A separate broker connection owned by the harness, for reading queues in tests. */
  inspect: RabbitConnection;
  /** Stop it to simulate losing the broker; `stop()` tolerates an already-stopped container. */
  rabbitContainer: StartedRabbitMQContainer;
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
  let inspect: RabbitConnection | undefined;
  let storageDir: string | undefined;
  // Always runs to the end: containers and the temp dir are released even if closing the app throws.
  // Cleanup failures of the containers themselves are best-effort (testcontainers' reaper is the net),
  // which is also what lets a test stop the broker container itself.
  const teardown = async () => {
    try {
      await inspect?.close();
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
    // The API connects to the broker lazily, so the harness asserts the same topology itself: tests
    // read the ingest queue through this connection and never touch the publisher's private channel.
    inspect = await connectRabbit(mq.getAmqpUrl(), {
      retryDelaysMs: ready.get<ApiConfig>(API_ENV).INGEST_RETRY_DELAYS_MS,
    });
    return {
      app: ready,
      http: request(ready.getHttpServer()),
      db: pg.db,
      redis: ready.get(REDIS),
      rabbit: ready.get<RabbitPublisher>(RABBIT),
      inspect,
      rabbitContainer: mq,
      storageDir,
      stop: teardown,
    };
  } catch (err) {
    await teardown().catch(() => undefined);
    throw err;
  }
}
