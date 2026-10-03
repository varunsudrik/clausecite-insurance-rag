import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.stop();
});

describe('GET /health', () => {
  it('reports every dependency as up', async () => {
    const res = await h.http.get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { db: true, redis: true, rabbitmq: true } });
  });

  it('sets security headers', async () => {
    const res = await h.http.get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
