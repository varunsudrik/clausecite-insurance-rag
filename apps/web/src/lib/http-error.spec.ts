import { describe, expect, it } from 'vitest';
import { ApiError, errorFromResponse, messageOf, retryAfterOf } from './http-error';

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

describe('retryAfterOf', () => {
  it('prefers the body over the header', () => {
    expect(retryAfterOf({ retryAfterSeconds: 42 }, new Headers({ 'retry-after': '99' }))).toBe(42);
  });

  it('falls back to a positive numeric header and ignores junk', () => {
    expect(retryAfterOf({ message: 'x' }, new Headers({ 'retry-after': '90' }))).toBe(90);
    expect(retryAfterOf(null, new Headers({ 'retry-after': '0' }))).toBeUndefined();
    expect(
      retryAfterOf('text', new Headers({ 'retry-after': 'Wed, 21 Oct 2026' })),
    ).toBeUndefined();
    expect(retryAfterOf(undefined, new Headers())).toBeUndefined();
  });
});

describe('messageOf / errorFromResponse', () => {
  it('reads string and array messages and falls back otherwise', () => {
    expect(messageOf({ message: 'nope' }, 'fb')).toBe('nope');
    expect(messageOf({ message: ['a', 'b'] }, 'fb')).toBe('a, b');
    expect(messageOf('plain text', 'fb')).toBe('fb');
    expect(messageOf(null, 'fb')).toBe('fb');
  });

  it('builds an ApiError carrying status, body and retry hint', () => {
    const body = { message: 'Rate limit exceeded' };
    const err = errorFromResponse(res(429, { 'retry-after': '30' }), body);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 429,
      message: 'Rate limit exceeded',
      retryAfterSeconds: 30,
    });
    expect(err.body).toBe(body);
    expect(errorFromResponse(res(500), null).message).toBe('request failed (500)');
  });
});
