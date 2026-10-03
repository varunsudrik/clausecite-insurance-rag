import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.stop();
});

describe('auth', () => {
  it('issues a guest token that authenticates /auth/me', async () => {
    const res = await h.http.post('/auth/guest').expect(201);
    expect(res.body).toMatchObject({
      token: expect.any(String),
      user: { role: 'guest' },
      expiresAt: expect.any(String),
    });
    const me = await h.http
      .get('/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`)
      .expect(200);
    expect(me.body).toEqual(res.body.user);
  });

  it('rejects requests without or with a bad token', async () => {
    await h.http.get('/auth/me').expect(401);
    await h.http.get('/auth/me').set('Authorization', 'Bearer garbage').expect(401);
  });

  it('logs in the seeded admin and rejects a wrong password', async () => {
    const ok = await h.http
      .post('/auth/login')
      .send({ email: 'admin@test.local', password: 'admin-pass-123' })
      .expect(200);
    expect(ok.body.user.role).toBe('admin');
    await h.http
      .post('/auth/login')
      .send({ email: 'admin@test.local', password: 'wrong' })
      .expect(401);
    await h.http.post('/auth/login').send({ email: 'not-an-email', password: 'x' }).expect(400);
  });
});
