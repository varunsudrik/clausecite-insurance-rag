import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../infra/tokens.js';
import { LimitsService } from './limits.service.js';

type Replies = [Error | null, unknown][] | null;

/** A Redis double whose MULTI chain resolves EXEC with whatever the test dictates. */
function service(replies: Replies) {
  const exec = vi.fn(async () => replies);
  const chain = { incr: () => chain, incrby: () => chain, expire: () => chain, exec };
  const multi = vi.fn(() => chain);
  const limits = new LimitsService(
    { multi } as unknown as Redis,
    {
      GUEST_DAILY_TOKEN_BUDGET: 1000,
    } as ApiConfig,
  );
  return { limits, multi };
}

const guest = { id: 'g', role: 'guest' as const };

describe('LimitsService fails closed on odd EXEC replies', () => {
  it('throws (rather than allowing) when EXEC is aborted and returns null', async () => {
    const { limits } = service(null);
    await expect(limits.check('guestToken', undefined, '1.1.1.1')).rejects.toThrow(/EXEC/);
  });

  it('throws the INCR error instead of treating the count as 0', async () => {
    const { limits } = service([
      [new Error('WRONGTYPE Operation against a key'), null],
      [null, 0],
    ]);
    await expect(limits.check('login', undefined, '1.1.1.1')).rejects.toThrow(/WRONGTYPE/);
  });

  it('throws when EXPIRE fails, so a counter can never be left without a TTL', async () => {
    const { limits } = service([
      [null, 1],
      [new Error('ERR boom'), null],
    ]);
    await expect(limits.check('chat', guest, '1.1.1.1')).rejects.toThrow(/boom/);
  });

  it('throws when INCR returns something that is not a number', async () => {
    const { limits } = service([
      [null, 'x'],
      [null, 1],
    ]);
    await expect(limits.check('guestToken', undefined, '1.1.1.1')).rejects.toThrow();
  });
});

describe('LimitsService.recordUsage', () => {
  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.4])(
    'ignores %s tokens without touching Redis',
    async (tokens) => {
      const { limits, multi } = service([]);
      await limits.recordUsage(guest, tokens);
      expect(multi).not.toHaveBeenCalled();
    },
  );

  it('never records for admins', async () => {
    const { limits, multi } = service([]);
    await limits.recordUsage({ id: 'a', role: 'admin' }, 500);
    expect(multi).not.toHaveBeenCalled();
  });

  it('throws when EXEC reports an error or is aborted', async () => {
    await expect(
      service([
        [new Error('OOM command not allowed'), null],
        [null, 1],
      ]).limits.recordUsage(guest, 10),
    ).rejects.toThrow(/OOM/);
    await expect(service(null).limits.recordUsage(guest, 10)).rejects.toThrow(/EXEC/);
  });

  it('records a positive amount', async () => {
    const { limits, multi } = service([
      [null, 10],
      [null, 1],
    ]);
    await limits.recordUsage(guest, 10);
    expect(multi).toHaveBeenCalledTimes(1);
  });
});
