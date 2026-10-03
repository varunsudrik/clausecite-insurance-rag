import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../infra/tokens.js';
import { LimitsService } from './limits.service.js';

type Replies = [Error | null, unknown][] | null;

/** A Redis double whose MULTI chain resolves EXEC with whatever the test dictates. */
function service(replies: Replies, get: () => Promise<string | null> = async () => null) {
  const exec = vi.fn(async () => replies);
  const incrby = vi.fn((_key: string, _amount: number) => chain);
  const chain = { incr: () => chain, incrby, expire: () => chain, exec };
  const multi = vi.fn(() => chain);
  const limits = new LimitsService(
    { multi, get: vi.fn(get) } as unknown as Redis,
    {
      GUEST_DAILY_TOKEN_BUDGET: 1000,
      GLOBAL_DAILY_TOKEN_BUDGET: 5000,
      SEARCH_TOKEN_COST: 300,
    } as ApiConfig,
  );
  return { limits, multi, incrby };
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

  it('records admin usage on the global key only', async () => {
    const { limits, incrby } = service([
      [null, 500],
      [null, 1],
    ]);
    await limits.recordUsage({ id: 'a', role: 'admin' }, 500);
    expect(incrby).toHaveBeenCalledTimes(1);
    expect(incrby).toHaveBeenCalledWith(
      expect.stringMatching(/^budget:global:\d{4}-\d{2}-\d{2}$/),
      500,
    );
  });

  it('records guest usage on the global and the per-guest keys in one transaction', async () => {
    const { limits, multi, incrby } = service([
      [null, 10],
      [null, 1],
      [null, 10],
      [null, 1],
    ]);
    await limits.recordUsage(guest, 10);
    expect(multi).toHaveBeenCalledTimes(1);
    expect(incrby.mock.calls.map(([key]) => key.replace(/\d{4}-\d{2}-\d{2}$/, 'DAY'))).toEqual([
      'budget:global:DAY',
      'budget:g:DAY',
    ]);
  });

  it('chargeSearch records SEARCH_TOKEN_COST', async () => {
    const { limits, incrby } = service([
      [null, 300],
      [null, 1],
      [null, 300],
      [null, 1],
    ]);
    await limits.chargeSearch(guest);
    expect(incrby).toHaveBeenCalledWith(expect.any(String), 300);
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

describe('LimitsService.assertBudget fails closed', () => {
  it('rejects when Redis cannot be read, for guests and admins alike', async () => {
    const down = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(service([], down).limits.assertBudget(guest)).rejects.toThrow(/ECONNREFUSED/);
    await expect(service([], down).limits.assertBudget({ id: 'a', role: 'admin' })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it('rejects when the global counter is unreadable as a number', async () => {
    await expect(service([], async () => 'nope').limits.assertBudget(guest)).rejects.toThrow();
  });
});
