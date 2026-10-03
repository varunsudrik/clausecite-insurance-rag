import { createHmac, randomUUID } from 'node:crypto';
import { eq, users } from '@clausecite/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const nowSeconds = () => Math.floor(Date.now() / 1000);

const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
    sub: string;
    role: string;
    iat: number;
    exp: number;
  };

/** Hand-rolled JWT so tests can forge tokens the API's own signer would never produce. */
function forge(alg: 'HS256' | 'HS512', payload: Record<string, unknown>, secret: string): string {
  const signingInput = `${b64({ alg, typ: 'JWT' })}.${b64(payload)}`;
  const hmac = createHmac(alg === 'HS256' ? 'sha256' : 'sha512', secret);
  return `${signingInput}.${hmac.update(signingInput).digest('base64url')}`;
}

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

  it('issues guest tokens valid for exactly 24 h', async () => {
    const res = await h.http.post('/auth/guest').expect(201);
    const claims = decode(res.body.token);
    expect(claims.exp - claims.iat).toBe(24 * 60 * 60);
    expect(claims.role).toBe('guest');
    expect(claims.sub).toBe(res.body.user.id);
  });

  it('issues admin tokens valid for exactly 12 h that authenticate as admin', async () => {
    const res = await h.http
      .post('/auth/login')
      .send({ email: 'admin@test.local', password: 'admin-pass-123' })
      .expect(200);
    const claims = decode(res.body.token);
    expect(claims.exp - claims.iat).toBe(12 * 60 * 60);
    const me = await h.http
      .get('/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`)
      .expect(200);
    expect(me.body).toMatchObject({ role: 'admin' });
    expect(me.body).toEqual(res.body.user);
  });

  it('matches the admin email case-insensitively', async () => {
    await h.http
      .post('/auth/login')
      .send({ email: 'Admin@Test.LOCAL', password: 'admin-pass-123' })
      .expect(200);
  });

  it('seeds exactly one admin row on boot, with a lowercased email', async () => {
    const rows = await h.db.select().from(users).where(eq(users.role, 'admin'));
    expect(rows.map((r) => r.email)).toEqual(['admin@test.local']);
  });

  describe('forged tokens (signed with the real secret, so only the guard rules can stop them)', () => {
    // Read lazily: the harness sets JWT_SECRET in beforeAll, after this block is collected.
    const secret = () => process.env.JWT_SECRET ?? '';
    const claims = () => ({ sub: randomUUID(), role: 'guest', exp: nowSeconds() + 60 });
    const me = (token: string) => h.http.get('/auth/me').set('Authorization', `Bearer ${token}`);

    it('control: a well-formed HS256 token with the right secret is accepted (stateless)', async () => {
      const payload = claims();
      const res = await me(forge('HS256', payload, secret())).expect(200);
      expect(res.body).toEqual({ id: payload.sub, role: 'guest' });
    });

    it('rejects an HS512 token even though it is signed with the right secret', async () => {
      await me(forge('HS512', claims(), secret())).expect(401);
    });

    it('rejects an HS256 token signed with a different secret', async () => {
      await me(forge('HS256', claims(), 'y'.repeat(40))).expect(401);
    });

    it('rejects an expired token', async () => {
      await me(forge('HS256', { ...claims(), exp: nowSeconds() - 10 }, secret())).expect(401);
    });

    it('rejects an unsigned alg:none token', async () => {
      const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims(), role: 'admin' })}.`;
      await me(unsigned).expect(401);
    });

    it('rejects a correctly signed token carrying an unknown role', async () => {
      await me(forge('HS256', { ...claims(), role: 'superuser' }, secret())).expect(401);
    });
  });
});
