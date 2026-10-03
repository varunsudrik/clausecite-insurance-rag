import { Catch, HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';

/**
 * Every 429 that carries a numeric `retryAfterSeconds` in its body also gets a `Retry-After`
 * header (rate limits and the daily token budget alike), then Nest's default handling replies.
 * All other HttpExceptions pass straight through to the default behaviour.
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
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
        host
          .switchToHttp()
          .getResponse<Response>()
          .setHeader('Retry-After', String(Math.ceil(seconds)));
      }
    }
    super.catch(exception, host);
  }
}
