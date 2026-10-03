import { Catch, HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';

/**
 * Every 429 that carries a numeric `retryAfterSeconds` in its body also gets a `Retry-After`
 * header (rate limits and the daily token budget alike), then Nest's default handling replies.
 * The header is skipped when the response has already started (headers sent). All other
 * HttpExceptions pass straight through to the default behaviour.
 */
@Catch(HttpException)
export class TooManyRequestsFilter extends BaseExceptionFilter<HttpException> {
  override catch(exception: HttpException, host: ArgumentsHost): void {
    if (exception.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
      const body = exception.getResponse();
      const seconds =
        typeof body === 'object' && body !== null
          ? (body as { retryAfterSeconds?: unknown }).retryAfterSeconds
          : undefined;
      const res = host.switchToHttp().getResponse<Response>();
      // A 429 thrown after streaming began (headers already flushed) must not crash on setHeader.
      if (
        !res.headersSent &&
        typeof seconds === 'number' &&
        Number.isFinite(seconds) &&
        seconds >= 0
      ) {
        res.setHeader('Retry-After', String(Math.ceil(seconds)));
      }
    }
    super.catch(exception, host);
  }
}
