/**
 * R-175: every checkRateLimit call must reach the shared counter. The verdict
 * comes from the count the database returns, never from process-local state.
 *
 * The limiter's pool is mocked here; the real proof against PostgreSQL is
 * tests/integration/r175-rate-limit-admits-over-max.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/rateLimitPool', () => ({
  getRateLimitPool: () => ({ query: async (...args: unknown[]) => ({ rows: await sqlMock(...args) }) }),
}));

import { checkRateLimit, clearRateLimitCache, refundRateLimit } from '@/lib/rateLimit';

/** A counter that behaves like the table row: each upsert adds its cost. */
function countingDb(): void {
  let count = 0;
  sqlMock.mockImplementation(async (_text: string, [, cost]: [string, number, number]) => {
    count += cost;
    return [{ count, remaining_ms: 60_000 }];
  });
}

describe('checkRateLimit — every call is counted (R-175)', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    clearRateLimitCache();
  });

  it('sends one upsert per call, even far below the limit', async () => {
    countingDb();
    for (let i = 0; i < 10; i++) expect(await checkRateLimit('k', { max: 100, windowSecs: 60 })).toBe(true);

    expect(sqlMock).toHaveBeenCalledTimes(10);
  });

  it('admits exactly max of 70 calls on one process, and asks the database for every admission', async () => {
    countingDb();
    let admitted = 0;
    for (let i = 0; i < 70; i++) if (await checkRateLimit('k', { max: 20, windowSecs: 60 })) admitted++;

    expect(admitted).toBe(20);
    // 20 admitted and the first refusal; the other 49 are refused from memory.
    expect(sqlMock).toHaveBeenCalledTimes(21);
  });

  it('admits at max and refuses at max + 1', async () => {
    sqlMock.mockResolvedValueOnce([{ count: 20, remaining_ms: 60_000 }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(true);
    sqlMock.mockResolvedValueOnce([{ count: 21, remaining_ms: 60_000 }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(false);
  });

  it('charges the clamped cost', async () => {
    countingDb();
    await checkRateLimit('k', { max: 100, windowSecs: 60, cost: 7 });
    await checkRateLimit('k', { max: 100, windowSecs: 60, cost: -3 });

    expect(sqlMock.mock.calls.map((call) => call[1][1])).toEqual([7, 1]);
  });

  it('remembers a refusal, and only a refusal: memory never admits', async () => {
    sqlMock.mockResolvedValueOnce([{ count: 21, remaining_ms: 60_000 }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(false);
    // Whatever the database would say now, it is not asked.
    sqlMock.mockResolvedValue([{ count: 1, remaining_ms: 60_000 }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(false);
    expect(sqlMock).toHaveBeenCalledTimes(1);

    // An admission is never remembered: each of these asks the database.
    expect(await checkRateLimit('other', { max: 20, windowSecs: 60 })).toBe(true);
    expect(await checkRateLimit('other', { max: 20, windowSecs: 60 })).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('does not remember a refusal whose window has already ended', async () => {
    sqlMock.mockResolvedValueOnce([{ count: 21, remaining_ms: 0 }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(false);
    sqlMock.mockResolvedValueOnce([{ count: 1, remaining_ms: 60_000 }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(true);
  });

  // Real time, and only a lower bound is waited for, so load cannot fail it.
  // The REFUSAL_TTL_MS cap is proven in r175-refusal-cache.int.test.ts.
  it('remembers a refusal no longer than the window has left', async () => {
    sqlMock.mockResolvedValueOnce([{ count: 21, remaining_ms: 1_000 }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(false);
    sqlMock.mockResolvedValue([{ count: 1, remaining_ms: 60_000 }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(true);
  });

  it('clearRateLimitCache and refundRateLimit each forget a remembered refusal', async () => {
    sqlMock.mockResolvedValue([{ count: 21, remaining_ms: 60_000 }]);
    expect(await checkRateLimit('a', { max: 20, windowSecs: 60 })).toBe(false);
    expect(await checkRateLimit('b', { max: 20, windowSecs: 60 })).toBe(false);
    expect(sqlMock).toHaveBeenCalledTimes(2);

    clearRateLimitCache();
    await checkRateLimit('a', { max: 20, windowSecs: 60 });
    expect(sqlMock).toHaveBeenCalledTimes(3);

    await refundRateLimit('b', 1);
    await checkRateLimit('b', { max: 20, windowSecs: 60 });
    expect(sqlMock).toHaveBeenCalledTimes(5);
  });

  it('refundRateLimit sends the clamped units', async () => {
    sqlMock.mockResolvedValue([]);
    await refundRateLimit('k', 2);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls[0]![1]).toEqual(['k', 2]);
  });
});
