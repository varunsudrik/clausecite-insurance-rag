import { describe, expect, it } from 'vitest';
import { describeChatError, describeError, formatWait, isConversationGone } from './errors';
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

describe('describeChatError', () => {
  it('explains a 429 with the wait time and the server reason', () => {
    expect(
      describeChatError(
        new Error('{"statusCode":429,"message":"Rate limit exceeded","retryAfterSeconds":42}'),
      ),
    ).toBe("You've hit the limit — try again in 42s. (Rate limit exceeded)");
    expect(
      describeChatError(
        new Error('{"message":"Daily token budget exhausted","retryAfterSeconds":7200}'),
      ),
    ).toBe("You've hit the limit — try again in 2 h. (Daily token budget exhausted)");
  });

  it('passes other API and stream error texts through', () => {
    expect(
      describeChatError(
        new Error('{"statusCode":404,"message":"one or more documents not found"}'),
      ),
    ).toBe('one or more documents not found');
    expect(
      describeChatError(
        new Error('Something went wrong while generating the answer. Please retry.'),
      ),
    ).toBe('Something went wrong while generating the answer. Please retry.');
  });

  it('explains a network failure', () => {
    expect(describeChatError(new TypeError('Failed to fetch'))).toMatch(
      /could not reach the server/i,
    );
  });
});

describe('a conversation the API no longer knows', () => {
  const gone = new Error(
    '{"message":"conversation not found","error":"Not Found","statusCode":404}',
  );

  it('is recognised from the 404 body', () => {
    expect(isConversationGone(gone)).toBe(true);
    expect(
      isConversationGone(
        new Error('{"message":"one or more documents not found","statusCode":404}'),
      ),
    ).toBe(false);
    expect(
      isConversationGone(new Error('{"message":"conversation not found","statusCode":500}')),
    ).toBe(false);
    expect(isConversationGone(new Error('conversation not found'))).toBe(false);
  });

  it('is explained as a fresh start instead of a bare "not found"', () => {
    expect(describeChatError(gone)).toMatch(/no longer available.*new chat/i);
  });
});
