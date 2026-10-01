/**
 * R-175: a call can only be admitted by the database. The verdict is the one
 * the statement returns; process memory can refuse, never admit.
 *
 * The limiter's pool is mocked here; the real proof against PostgreSQL is
 * tests/integration/r175-rate-limit-admits-over-max.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/rateLimitPool', () => ({
  getRateLimitPool: () => ({ query: async (...args: unknown[]) => ({ rows: await sqlMock(...args) }) }),
}));

import { chargeRateLimit, checkRateLimit, clearRateLimitCache, refundRateLimit } from '@/lib/rateLimit';

const WINDOW = '2026-10-01 10:00:00.123456+00';
const admitted = (count: number) => [{ admitted: true, count, window_start: WINDOW, remaining_ms: 60_000 }];
const refusedAt = (count: number, remaining_ms = 60_000) => [{ admitted: false, count, window_start: WINDOW, remaining_ms }];

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

  it('a remembered refusal turns away only a call that still would not fit', async () => {
    // 15 used; a 10-unit call was refused.
    sqlMock.mockResolvedValueOnce(refusedAt(15));
    expect(await checkRateLimit('k', { ...limit, cost: 10 })).toBe(false);
    sqlMock.mockResolvedValue(admitted(20));

    // 15 + 6 does not fit: refused from memory. 15 + 5 fits: the database is asked.
    expect(await checkRateLimit('k', { ...limit, cost: 6 })).toBe(false);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(await checkRateLimit('k', { ...limit, cost: 5 })).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(2);
    // And a caller with a higher max on the same key is asked too.
    expect(await checkRateLimit('k', { max: 100, windowSecs: 60, cost: 10 })).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(3);
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
