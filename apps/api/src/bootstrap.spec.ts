import type { INestApplication } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { configureApp } from './bootstrap.js';

function fakeApp(TRUST_PROXY_HOPS: number) {
  const set = vi.fn();
  const app = {
    get: () => ({ WEB_ORIGIN: 'http://localhost:3000', TRUST_PROXY_HOPS }),
    use: vi.fn(),
    enableCors: vi.fn(),
    set,
  };
  return { app: app as unknown as INestApplication, set, use: app.use };
}

type Middleware = (req: object, res: object, next: () => void) => void;

describe('configureApp', () => {
  it.each([0, 1, 2])('sets trust proxy to TRUST_PROXY_HOPS=%i', (hops) => {
    const { app, set } = fakeApp(hops);
    configureApp(app);
    expect(set).toHaveBeenCalledWith('trust proxy', hops);
  });

  it('leaves Strict-Transport-Security to the reverse proxy but keeps the other helmet headers', () => {
    const { app, use } = fakeApp(1);
    configureApp(app);
    const helmetMiddleware = use.mock.calls[0]?.[0] as Middleware;
    const headers = new Map<string, string>();
    const res = {
      setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), String(value)),
      removeHeader: (name: string) => headers.delete(name.toLowerCase()),
    };
    const next = vi.fn();
    helmetMiddleware({}, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(headers.has('strict-transport-security')).toBe(false);
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });
});
