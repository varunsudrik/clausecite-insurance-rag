import { describe, expect, it } from 'vitest';
import { describeError, formatWait } from './errors';
import { ApiError } from './api';
import { AuthError } from './session';

describe('describeError', () => {
  it('adds the wait time to rate-limit errors from the API client and the auth calls', () => {
    expect(describeError(new ApiError('Rate limit exceeded', 429, null, 42))).toBe(
      'Rate limit exceeded. Try again in 42 s.',
    );
    expect(describeError(new AuthError('Rate limit exceeded', 429, 840))).toBe(
      'Rate limit exceeded. Try again in 14 min.',
    );
  });

  it('passes other messages through and explains network failures', () => {
    expect(describeError(new AuthError('Invalid credentials', 401))).toBe('Invalid credentials');
    expect(describeError(new TypeError('Failed to fetch'))).toMatch(/could not reach the server/i);
  });

  it('formats waits in seconds, minutes or hours', () => {
    expect(formatWait(0.2)).toBe('1 s');
    expect(formatWait(89)).toBe('89 s');
    expect(formatWait(120)).toBe('2 min');
    expect(formatWait(7200)).toBe('2 h');
  });
});
