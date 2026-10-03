import { readFileSync } from 'node:fs';
import { documents } from '@clausecite/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHarness, type Harness } from './harness.js';

const PDF = readFileSync(new URL('../../../data/fixtures/sample-policy.pdf', import.meta.url));

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

  it('sets security headers', async () => {
    const res = await h.http.get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('when RabbitMQ is lost (DECISIONS 011)', () => {
  let h: Harness;
  // Vitest turns a real process.exit into a thrown error, which would be easy to miss: record the calls.
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.stop();
    exit.mockRestore();
  });

  it('keeps serving: /health degrades to rabbitmq:false within 5 s, then keeps answering', async () => {
    await h.http.get('/health').expect(200); // the publisher has connected by now
    await h.rabbitContainer.stop();

    const started = Date.now();
    const res = await h.http.get('/health').expect(503);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.body).toEqual({
      status: 'degraded',
      checks: { db: true, redis: true, rabbitmq: false },
    });

    // the process is still alive and serving, and the publisher still reports the broker as down
    const again = await h.http.get('/health').expect(503);
    expect(again.body.checks).toEqual({ db: true, redis: true, rabbitmq: false });
    await h.http.post('/auth/guest').expect(201);
    expect(exit).not.toHaveBeenCalled();
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
