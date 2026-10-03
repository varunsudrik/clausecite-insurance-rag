import { readFileSync } from 'node:fs';
import { documents } from '@clausecite/core';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { startHarness, type Harness } from './harness.js';

const PDF = readFileSync(new URL('../../../data/fixtures/sample-policy.pdf', import.meta.url));

/**
 * Vitest turns a real process.exit into a thrown error that is easy to miss, so a describe that must
 * prove the API never exits records the calls instead. Install it in beforeAll, restore in afterAll.
 */
const recordProcessExit = () =>
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

const DEGRADED = {
  status: 'degraded',
  checks: { db: true, redis: true, rabbitmq: false },
};

describe('GET /health', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('reports every dependency as up', async () => {
    const res = await h.http.get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { db: true, redis: true, rabbitmq: true } });
  });

  it('sets security headers, but leaves Strict-Transport-Security to the reverse proxy', async () => {
    const res = await h.http.get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('when RabbitMQ is lost after boot (DECISIONS 011)', () => {
  let h: Harness;
  let exit: MockInstance;
  beforeAll(async () => {
    exit = recordProcessExit();
    h = await startHarness();
    await h.http.get('/health').expect(200); // warm-up: the publisher holds an established connection
    await h.rabbitContainer.stop();
  });
  afterAll(async () => {
    try {
      await h?.stop();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it('keeps serving: /health degrades to rabbitmq:false within 5 s, then keeps answering', async () => {
    const started = Date.now();
    const res = await h.http.get('/health').expect(503);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.body).toEqual(DEGRADED);

    // the process is still alive and serving, and the publisher still reports the broker as down
    const again = await h.http.get('/health').expect(503);
    expect(again.body).toEqual(DEGRADED);
    await h.http.post('/auth/guest').expect(201);
  });

  it('answers uploads with 503 and leaves no document behind', async () => {
    const login = await h.http
      .post('/auth/login')
      .send({ email: 'admin@test.local', password: 'admin-pass-123' });
    const res = await h.http
      .post('/documents')
      .set('Authorization', `Bearer ${login.body.token}`)
      .field('slug', 'broker-down')
      .field('title', 'Broker down')
      .field('insurer', 'Acme')
      .field('product', 'Broker down')
      .attach('file', PDF, { filename: 'policy.pdf', contentType: 'application/pdf' })
      .expect(503);
    expect(res.body.message).toBe('could not enqueue ingestion, please retry');
    expect(await h.db.select().from(documents)).toEqual([]);
  });
});

describe('when RabbitMQ is unreachable at boot (DECISIONS 011)', () => {
  let h: Harness;
  let exit: MockInstance;
  let warn: MockInstance;
  beforeAll(async () => {
    exit = recordProcessExit();
    warn = vi.spyOn(Logger.prototype, 'warn');
    // Nothing listens on port 1: connecting is refused at once. The password must never reach a log.
    h = await startHarness({ rabbitUrl: 'amqp://app:hunter2@127.0.0.1:1' });
  });
  afterAll(async () => {
    try {
      await h?.stop();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      warn.mockRestore();
    }
  });

  it('boots, serves, reports rabbitmq:false within 5 s and logs the connect failure once', async () => {
    // beforeAll got here, so app.init() succeeded without a broker
    const started = Date.now();
    const res = await h.http.get('/health').expect(503);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.body).toEqual(DEGRADED);

    await h.http.get('/health').expect(503);
    await h.http.post('/auth/guest').expect(201);

    const logged = warn.mock.calls.map((c) => String(c[0]));
    const failures = logged.filter((m) => m.startsWith('RabbitMQ connect failed:'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('ECONNREFUSED');
    expect(logged.join('\n')).not.toContain('hunter2');
  });
});
