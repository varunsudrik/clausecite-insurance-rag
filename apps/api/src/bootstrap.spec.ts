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
  return { app: app as unknown as INestApplication, set };
}

describe('configureApp', () => {
  it.each([0, 1, 2])('sets trust proxy to TRUST_PROXY_HOPS=%i', (hops) => {
    const { app, set } = fakeApp(hops);
    configureApp(app);
    expect(set).toHaveBeenCalledWith('trust proxy', hops);
  });
});
