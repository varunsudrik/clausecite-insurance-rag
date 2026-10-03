import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.stop();
});

describe('guest token rate limit', () => {
  it('returns 429 with Retry-After on the 6th guest token from one IP', async () => {
    for (let i = 0; i < 5; i++)
      await h.http.post('/auth/guest').set('X-Forwarded-For', '9.9.9.9').expect(201);
    const res = await h.http.post('/auth/guest').set('X-Forwarded-For', '9.9.9.9').expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    await h.http.post('/auth/guest').set('X-Forwarded-For', '8.8.8.8').expect(201); // other IPs unaffected
  });
});

describe('login rate limit', () => {
  const attempt = (ip: string, password: string) =>
    h.http
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'admin@test.local', password });

  it('returns 429 with Retry-After on the 11th login attempt from one IP', async () => {
    for (let i = 0; i < 10; i++) await attempt('7.7.7.7', 'wrong').expect(401);
    const res = await attempt('7.7.7.7', 'admin-pass-123').expect(429); // even the right password
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    await attempt('6.6.6.6', 'admin-pass-123').expect(200); // other IPs unaffected
  });
});

describe('IPv6 clients', () => {
  it('shares one guest-token bucket across a whole /64 and keeps other /64s apart', async () => {
    for (let i = 1; i <= 5; i++)
      await h.http.post('/auth/guest').set('X-Forwarded-For', `2001:db8:5:6::${i}`).expect(201);
    await h.http.post('/auth/guest').set('X-Forwarded-For', '2001:db8:5:6:ffff::1').expect(429);
    await h.http.post('/auth/guest').set('X-Forwarded-For', '2001:db8:5:7::1').expect(201);
  });
});
