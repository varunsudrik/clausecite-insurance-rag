import { BadRequestException, HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TooManyRequestsFilter } from './too-many-requests.filter.js';

function setup() {
  const response = { setHeader: vi.fn() };
  const adapter = { reply: vi.fn(), end: vi.fn(), isHeadersSent: vi.fn(() => false) };
  const host = {
    getArgByIndex: (i: number) => (i === 1 ? response : undefined),
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  // Constructor takes the HTTP adapter (Nest injects HttpAdapterHost when registered via APP_FILTER).
  const filter = new TooManyRequestsFilter(adapter as never);
  return { response, adapter, host, filter };
}

describe('TooManyRequestsFilter', () => {
  it('sets Retry-After from a 429 body and replies with the original body', () => {
    const { response, adapter, host, filter } = setup();
    const body = { message: 'Daily token budget exhausted', retryAfterSeconds: 42 };
    filter.catch(new HttpException(body, HttpStatus.TOO_MANY_REQUESTS), host);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '42');
    expect(adapter.reply).toHaveBeenCalledWith(response, body, 429);
  });

  it('rounds a fractional retryAfterSeconds up to whole seconds', () => {
    const { response, host, filter } = setup();
    filter.catch(new HttpException({ retryAfterSeconds: 1.2 }, HttpStatus.TOO_MANY_REQUESTS), host);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '2');
  });

  it('leaves a 429 without a numeric retryAfterSeconds untouched', () => {
    const { response, adapter, host, filter } = setup();
    filter.catch(new HttpException('slow down', HttpStatus.TOO_MANY_REQUESTS), host);
    filter.catch(
      new HttpException({ retryAfterSeconds: 'soon' }, HttpStatus.TOO_MANY_REQUESTS),
      host,
    );
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(adapter.reply).toHaveBeenCalledTimes(2);
  });

  it('does not touch non-429 responses, even if the body has retryAfterSeconds', () => {
    const { response, adapter, host, filter } = setup();
    const bad = new BadRequestException('nope');
    filter.catch(bad, host);
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(adapter.reply).toHaveBeenLastCalledWith(response, bad.getResponse(), 400);

    filter.catch(new HttpException({ retryAfterSeconds: 5 }, HttpStatus.SERVICE_UNAVAILABLE), host);
    expect(response.setHeader).not.toHaveBeenCalled();
  });
});
