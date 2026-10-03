import type { DbHandle } from '@clausecite/core';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ApiConfig } from '../infra/tokens.js';
import { AuthService } from './auth.service.js';

const SECRET = 's'.repeat(40);
const GOOD_PASSWORD = 'a-long-enough-password';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const nowSeconds = () => Math.floor(Date.now() / 1000);

function makeService(env: Partial<ApiConfig> = {}, db: unknown = {}) {
  // Same options as AuthModule: HS256 pinned for signing and for verifying.
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { algorithm: 'HS256' },
    verifyOptions: { algorithms: ['HS256'] },
  });
  const service = new AuthService({ db } as unknown as DbHandle, jwt, env as ApiConfig);
  return { service, jwt };
}

const selectStub = (rows: unknown[]) => ({
  select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
});

function insertStub(returned: { id: string }[] = [{ id: 'a1' }]) {
  const returning = vi.fn(async () => returned);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn((_row: Record<string, unknown>) => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert }, insert, values };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthService.verify (real JwtService)', () => {
  const claims = { sub: 'u1', role: 'guest' };

  it('accepts a validly signed token and returns the user', async () => {
    const { service, jwt } = makeService();
    const token = await jwt.signAsync(claims, { expiresIn: 60 });
    await expect(service.verify(token)).resolves.toEqual({ id: 'u1', role: 'guest' });
  });

  const rejected: [string, (jwt: JwtService) => Promise<string>][] = [
    ['not a jwt at all', async () => 'garbage'],
    [
      'a token signed with a different secret',
      () => new JwtService({ secret: 'z'.repeat(40) }).signAsync(claims, { expiresIn: 60 }),
    ],
    ['an expired token', (jwt) => jwt.signAsync({ ...claims, exp: nowSeconds() - 10 })],
    [
      'a token whose payload was tampered with (role flipped to admin, signature kept)',
      async (jwt) => {
        const good = await jwt.signAsync(claims, { expiresIn: 60 });
        const [header, payload, signature] = good.split('.');
        const tampered = {
          ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
          role: 'admin',
        };
        return `${header}.${b64(tampered)}.${signature}`;
      },
    ],
    [
      'an unsigned alg:none token',
      async () =>
        `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, role: 'admin', exp: nowSeconds() + 60 })}.`,
    ],
    [
      'an HS512 token signed with the correct secret (algorithm is pinned to HS256)',
      (jwt) => jwt.signAsync(claims, { algorithm: 'HS512', expiresIn: 60 }),
    ],
    ['a signed token without sub', (jwt) => jwt.signAsync({ role: 'guest' }, { expiresIn: 60 })],
    [
      'a signed token with an empty sub',
      (jwt) => jwt.signAsync({ sub: '', role: 'guest' }, { expiresIn: 60 }),
    ],
    [
      'a signed token with a non-string sub',
      (jwt) => jwt.signAsync({ sub: 42, role: 'guest' }, { expiresIn: 60 }),
    ],
    [
      'a signed token with an unknown role',
      (jwt) => jwt.signAsync({ sub: 'u1', role: 'superuser' }, { expiresIn: 60 }),
    ],
    ['a signed token without role', (jwt) => jwt.signAsync({ sub: 'u1' }, { expiresIn: 60 })],
  ];

  it.each(rejected)('rejects %s with 401', async (_name, makeToken) => {
    const { service, jwt } = makeService();
    const token = await makeToken(jwt);
    await expect(service.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService.login (timing-safe)', () => {
  let verifySpy: MockInstance<typeof argon2.verify>;
  beforeEach(() => {
    verifySpy = vi.spyOn(argon2, 'verify');
  });

  it('still runs argon2.verify against a (shared, lazily computed) dummy hash for an unknown email', async () => {
    const { service } = makeService({}, selectStub([]));
    await expect(service.login('nobody@test.local', 'whatever')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.login('nobody@test.local', 'whatever')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verifySpy).toHaveBeenCalledTimes(2);
    const [first, second] = verifySpy.mock.calls.map((call) => call[0]);
    expect(first).toMatch(/^\$argon2/);
    expect(second).toBe(first);
  });

  it('verifies against the stored hash for a wrong password and rejects', async () => {
    const passwordHash = await argon2.hash(GOOD_PASSWORD);
    const { service } = makeService({}, selectStub([{ id: 'a1', role: 'admin', passwordHash }]));
    await expect(service.login('admin@test.local', 'wrong')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verifySpy).toHaveBeenCalledWith(passwordHash, 'wrong');
  });

  it('rejects (after a dummy verify) an admin row that has no password hash', async () => {
    const { service } = makeService(
      {},
      selectStub([{ id: 'a1', role: 'admin', passwordHash: null }]),
    );
    await expect(service.login('admin@test.local', 'x')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('issues a token for the right password', async () => {
    const passwordHash = await argon2.hash(GOOD_PASSWORD);
    const { service, jwt } = makeService(
      {},
      selectStub([{ id: 'a1', role: 'admin', passwordHash }]),
    );
    const issued = await service.login('admin@test.local', GOOD_PASSWORD);
    expect(issued.user).toEqual({ id: 'a1', role: 'admin' });
    await expect(service.verify(issued.token)).resolves.toEqual({ id: 'a1', role: 'admin' });
    const decoded = jwt.decode(issued.token) as { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBe(12 * 60 * 60);
  });
});

describe('AuthService.onApplicationBootstrap (admin seeding)', () => {
  let warn: MockInstance<Logger['warn']>;
  let info: MockInstance<Logger['log']>;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    info = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  const skipped: [string, Partial<ApiConfig>][] = [
    ['only ADMIN_EMAIL is set', { ADMIN_EMAIL: 'admin@test.local' }],
    ['only ADMIN_PASSWORD is set', { ADMIN_PASSWORD: GOOD_PASSWORD }],
    [
      'the password is the change-me placeholder',
      { ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'change-me' },
    ],
    [
      'the password is shorter than 12 characters',
      { ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'elevenchars' },
    ],
  ];

  it.each(skipped)(
    'skips seeding and warns (without leaking the password) when %s',
    async (_name, env) => {
      const stub = insertStub();
      const { service } = makeService(env, stub.db);
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(stub.insert).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      // The placeholder is a public, documented value (it is named in the message); real ones are not.
      if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD !== 'change-me') {
        expect(String(warn.mock.calls[0]?.[0])).not.toContain(env.ADMIN_PASSWORD);
      }
    },
  );

  it('does nothing (no insert, no warning) when no admin is configured', async () => {
    const stub = insertStub();
    const { service } = makeService({}, stub.db);
    await service.onApplicationBootstrap();
    expect(stub.insert).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('creates the admin with a lowercased email and an argon2 hash, and logs at info', async () => {
    const stub = insertStub([{ id: 'a1' }]);
    const { service } = makeService(
      { ADMIN_EMAIL: 'Admin@Test.LOCAL', ADMIN_PASSWORD: GOOD_PASSWORD },
      stub.db,
    );
    await service.onApplicationBootstrap();
    expect(stub.insert).toHaveBeenCalledTimes(1);
    const row = stub.values.mock.calls[0]?.[0];
    expect(row).toMatchObject({ email: 'admin@test.local', role: 'admin' });
    expect(String(row?.passwordHash)).toMatch(/^\$argon2/);
    expect(warn).not.toHaveBeenCalled();
    expect(String(info.mock.calls.at(-1)?.[0])).toMatch(/created/i);
  });

  it('is a logged no-op when the admin already exists', async () => {
    const stub = insertStub([]);
    const { service } = makeService(
      { ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: GOOD_PASSWORD },
      stub.db,
    );
    await service.onApplicationBootstrap();
    expect(warn).not.toHaveBeenCalled();
    expect(String(info.mock.calls.at(-1)?.[0])).toMatch(/already exists/i);
  });
});
