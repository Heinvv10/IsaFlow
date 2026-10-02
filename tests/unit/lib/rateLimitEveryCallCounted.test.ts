/**
 * R-175: a call can only be admitted by the database. The verdict is the one
 * the statement returns; process memory can refuse, never admit.
 *
 * The limiter's pool is mocked here; the real proof against PostgreSQL is
 * tests/integration/r175-rate-limit-admits-over-max.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, latestMock } = vi.hoisted(() => ({ sqlMock: vi.fn(), latestMock: vi.fn() }));
vi.mock('@/lib/rateLimitPool', () => ({
  // The charge statement goes to sqlMock; the re-read of a refused key's latest count to latestMock.
  getRateLimitPool: () => ({
    query: async (text: string, params: unknown[]) =>
      ({ rows: await (text.trimStart().startsWith('SELECT count') ? latestMock : sqlMock)(text, params) }),
  }),
}));

import { chargeRateLimit, checkRateLimit, clearRateLimitCache, refundRateLimit } from '@/lib/rateLimit';
import { isKnownFull } from '@/lib/rateLimitCore';

const WINDOW = '2026-10-01 10:00:00.123456+00';
const admitted = (count: number) => [{ admitted: true, count, window_start: WINDOW, remaining_ms: 60_000 }];
/** A refusal, and by default the latest committed row agrees with it. */
function refusedAt(count: number, remaining_ms = 60_000) {
  latestMock.mockResolvedValue([{ count, window_start: WINDOW, remaining_ms }]);
  return [{ admitted: false, count, window_start: WINDOW, remaining_ms }];
}

/** A counter that behaves like the table row: a charge is added only when it fits. */
function countingDb(): void {
  let count = 0;
  sqlMock.mockImplementation(async (_text: string, [, cost, , max]: [string, number, number, number]) => {
    if (count + cost > max) return refusedAt(count);
    count += cost;
    return admitted(count);
  });
}

const limit = { max: 20, windowSecs: 60 };

describe('checkRateLimit — only the database admits (R-175)', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    latestMock.mockReset();
    latestMock.mockResolvedValue([]);
    clearRateLimitCache();
  });

  it('sends one statement per call, even far below the limit', async () => {
    countingDb();
    for (let i = 0; i < 10; i++) expect(await checkRateLimit('k', { max: 100, windowSecs: 60 })).toBe(true);

    expect(sqlMock).toHaveBeenCalledTimes(10);
  });

  it('admits exactly max of 70 calls on one process, and asks the database for every admission', async () => {
    countingDb();
    let n = 0;
    for (let i = 0; i < 70; i++) if (await checkRateLimit('k', limit)) n++;

    expect(n).toBe(20);
    // 20 admitted and the first refusal; the other 49 are refused from memory.
    expect(sqlMock).toHaveBeenCalledTimes(21);
  });

  it('takes its verdict from the statement, not from the count', async () => {
    sqlMock.mockResolvedValueOnce(admitted(20));
    expect(await checkRateLimit('a', limit)).toBe(true);
    sqlMock.mockResolvedValueOnce(refusedAt(3));
    expect(await checkRateLimit('b', limit)).toBe(false);
    // No row came back: created by someone else mid-statement and it did not fit.
    sqlMock.mockResolvedValueOnce([]);
    expect(await checkRateLimit('c', limit)).toBe(false);
  });

  it('sends the clamped cost and the limit, and returns the window that was charged', async () => {
    countingDb();
    const charge = await chargeRateLimit('k', { max: 100, windowSecs: 60, cost: 7 });
    await checkRateLimit('k', { max: 100, windowSecs: 60, cost: -3 });

    expect(charge).toEqual({ admitted: true, windowStart: WINDOW });
    expect(sqlMock.mock.calls.map((call) => call[1])).toEqual([['k', 7, 60, 100], ['k', 1, 60, 100]]);
  });

  it('a cost above the whole allowance is refused without asking', async () => {
    expect(await chargeRateLimit('k', { ...limit, cost: 21 })).toEqual({ admitted: false, windowStart: null });
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('remembers a refusal, and only a refusal: memory never admits', async () => {
    sqlMock.mockResolvedValueOnce(refusedAt(20));
    expect(await checkRateLimit('k', limit)).toBe(false);
    // Whatever the database would say now, it is not asked.
    sqlMock.mockResolvedValue(admitted(1));
    expect(await checkRateLimit('k', limit)).toBe(false);
    expect(sqlMock).toHaveBeenCalledTimes(1);

    // An admission is never remembered: each of these asks the database.
    expect(await checkRateLimit('other', limit)).toBe(true);
    expect(await checkRateLimit('other', limit)).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('remembers only a key that is full: a refused large call does not turn a small one away', async () => {
    // 15 used of 20; a 10-unit call was refused. Five units are left.
    sqlMock.mockResolvedValueOnce(refusedAt(15));
    expect(await checkRateLimit('k', { ...limit, cost: 10 })).toBe(false);
    sqlMock.mockResolvedValue(admitted(16));

    // Nothing was remembered: even another call that would not fit is asked of the database.
    expect(await checkRateLimit('k', limit)).toBe(true);
    expect(await checkRateLimit('k', { ...limit, cost: 6 })).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('a full key is refused from memory for a caller with that max, and asked for a caller with a higher one', async () => {
    sqlMock.mockResolvedValueOnce(refusedAt(20));
    expect(await checkRateLimit('k', limit)).toBe(false);
    sqlMock.mockResolvedValue(admitted(21));

    expect(await checkRateLimit('k', { ...limit, cost: 5 })).toBe(false);
    expect(await checkRateLimit('k', { max: 19, windowSecs: 60 })).toBe(false);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(await checkRateLimit('k', { max: 100, windowSecs: 60, cost: 10 })).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  // Review round 5: the refused row comes from the statement's snapshot.
  it('a refusal that read full from a stale snapshot is not remembered when the latest row has room', async () => {
    sqlMock.mockResolvedValueOnce(refusedAt(20));
    // A refund of 2 committed while the statement waited for the row lock.
    latestMock.mockResolvedValue([{ count: 18, window_start: WINDOW, remaining_ms: 60_000 }]);
    expect(await checkRateLimit('k', { ...limit, cost: 5 })).toBe(false);

    sqlMock.mockResolvedValueOnce(admitted(19));
    expect(await checkRateLimit('k', limit)).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('re-reads only when the refusal looked full, and remembers the latest count', async () => {
    sqlMock.mockResolvedValueOnce(refusedAt(15));
    expect(await checkRateLimit('a', { ...limit, cost: 10 })).toBe(false);
    expect(latestMock).not.toHaveBeenCalled();

    sqlMock.mockResolvedValueOnce(refusedAt(20));
    expect(await checkRateLimit('b', limit)).toBe(false);
    expect(latestMock).toHaveBeenCalledTimes(1);
    expect(latestMock.mock.calls[0]![1]).toEqual(['b', 60]);
    expect(await checkRateLimit('b', limit)).toBe(false);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('remembers nothing when the row is gone by the re-read', async () => {
    sqlMock.mockResolvedValueOnce(refusedAt(20));
    latestMock.mockResolvedValue([]);
    expect(await checkRateLimit('k', limit)).toBe(false);
    sqlMock.mockResolvedValueOnce(admitted(1));
    expect(await checkRateLimit('k', limit)).toBe(true);
  });

  it('isKnownFull: true only for a key reported full at a max no higher than the one asked', async () => {
    expect(isKnownFull('k', 20)).toBe(false);
    sqlMock.mockResolvedValueOnce(refusedAt(20));
    expect(await checkRateLimit('k', limit)).toBe(false);

    expect(isKnownFull('k', 20)).toBe(true);
    expect(isKnownFull('k', 5)).toBe(true);
    // A caller with a higher limit on the same key is not bound by it.
    expect(isKnownFull('k', 21)).toBe(false);
    expect(isKnownFull('other', 20)).toBe(false);
  });

  // Review round 4: `max` is a SQL integer parameter.
  it('floors a fractional max: 2.5 admits what 2 admits', async () => {
    countingDb();
    const fractional = { max: 2.5, windowSecs: 60 };
    expect([await checkRateLimit('k', fractional), await checkRateLimit('k', fractional), await checkRateLimit('k', fractional)])
      .toEqual([true, true, false]);
    expect(sqlMock.mock.calls.every((call) => call[1][3] === 2)).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 2_147_483_648, 1_000_000_001])(
    'refuses a max of %s as a programming error, before any statement', async (max) => {
      await expect(checkRateLimit('k', { max, windowSecs: 60 })).rejects.toThrow(RangeError);
      await expect(chargeRateLimit('k', { max, windowSecs: 60, cost: 5 })).rejects.toThrow(/rate limit max must be a number from 0 to 1000000000/);
      expect(sqlMock).not.toHaveBeenCalled();
    });

  it('accepts the edges: a max of 0 admits nothing, the largest max is passed through', async () => {
    countingDb();
    expect(await checkRateLimit('zero', { max: 0, windowSecs: 60 })).toBe(false);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(await checkRateLimit('big', { max: 1_000_000_000, windowSecs: 60 })).toBe(true);
    expect(sqlMock.mock.calls[0]![1][3]).toBe(1_000_000_000);
  });

  it('does not remember a refusal whose window has already ended', async () => {
    sqlMock.mockResolvedValueOnce(refusedAt(20, 0));
    expect(await checkRateLimit('k', limit)).toBe(false);
    sqlMock.mockResolvedValueOnce(admitted(1));
    expect(await checkRateLimit('k', limit)).toBe(true);
  });

  // Real time, and only a lower bound is waited for, so load cannot fail it.
  // The REFUSAL_TTL_MS cap is proven in r175-refusal-cache.int.test.ts.
  it('remembers a refusal no longer than the window has left', async () => {
    sqlMock.mockResolvedValueOnce(refusedAt(20, 1_000));
    expect(await checkRateLimit('k', limit)).toBe(false);
    sqlMock.mockResolvedValue(admitted(1));
    expect(await checkRateLimit('k', limit)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(await checkRateLimit('k', limit)).toBe(true);
  });

  it('clearRateLimitCache and refundRateLimit each forget a remembered refusal', async () => {
    sqlMock.mockResolvedValue(refusedAt(20));
    expect(await checkRateLimit('a', limit)).toBe(false);
    expect(await checkRateLimit('b', limit)).toBe(false);
    expect(sqlMock).toHaveBeenCalledTimes(2);

    clearRateLimitCache();
    await checkRateLimit('a', limit);
    expect(sqlMock).toHaveBeenCalledTimes(3);

    await refundRateLimit('b', 1);
    await checkRateLimit('b', limit);
    expect(sqlMock).toHaveBeenCalledTimes(5);
  });

  it('refundRateLimit sends the clamped units, and the window when it is given one', async () => {
    sqlMock.mockResolvedValue([]);
    await refundRateLimit('k', 2);
    await refundRateLimit('k', -9, WINDOW);

    expect(sqlMock.mock.calls.map((call) => call[1])).toEqual([['k', 2, null], ['k', 1, WINDOW]]);
  });
});
