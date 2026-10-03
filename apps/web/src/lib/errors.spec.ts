import { describe, expect, it } from 'vitest';
import { describeError, formatWait } from './errors';
import { ApiError } from './http-error';

describe('describeError', () => {
  it('adds the wait time to rate-limit errors', () => {
    expect(describeError(new ApiError('Rate limit exceeded', 429, null, 42))).toBe(
      'Rate limit exceeded. Try again in 42 s.',
    );
    expect(describeError(new ApiError('Rate limit exceeded', 429, null, 840))).toBe(
      'Rate limit exceeded. Try again in 14 min.',
    );
  });

  it('passes other messages through', () => {
    expect(describeError(new ApiError('Invalid credentials', 401, null))).toBe(
      'Invalid credentials',
    );
    expect(describeError('plain')).toBe('plain');
  });

  it('explains network failures in every browser dialect, but not unrelated TypeErrors', () => {
    for (const message of [
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
      'Load failed',
    ]) {
      expect(describeError(new TypeError(message))).toMatch(/could not reach the server/i);
    }
    expect(describeError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(
      "Cannot read properties of undefined (reading 'x')",
    );
  });

  it('formats waits in seconds, minutes or hours', () => {
    expect(formatWait(0.2)).toBe('1 s');
    expect(formatWait(89)).toBe('89 s');
    expect(formatWait(120)).toBe('2 min');
    expect(formatWait(7200)).toBe('2 h');
  });
});
