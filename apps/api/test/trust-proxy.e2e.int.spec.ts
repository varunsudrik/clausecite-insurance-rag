import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { TRUST_PROXY_HOPS: '0' } });
});
afterAll(async () => {
  await h?.stop();
});

describe('TRUST_PROXY_HOPS=0', () => {
  it('ignores X-Forwarded-For: spoofing a new address per request does not dodge the IP limit', async () => {
    for (let i = 1; i <= 5; i++)
      await h.http.post('/auth/guest').set('X-Forwarded-For', `198.51.100.${i}`).expect(201);
    const res = await h.http
      .post('/auth/guest')
      .set('X-Forwarded-For', '198.51.100.99')
      .expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});
