/**
 * R-175: every checkRateLimit call must reach the shared counter. The verdict
 * comes from the count the database returns, never from process-local state.
 *
 * `sql` is mocked here; the real proof against PostgreSQL is
 * tests/integration/r175-rate-limit-admits-over-max.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import { checkRateLimit, clearRateLimitCache, refundRateLimit } from '@/lib/rateLimit';

/** A counter that behaves like the table row: each upsert adds its cost. */
function countingDb(): void {
  let count = 0;
  sqlMock.mockImplementation(async (_strings: TemplateStringsArray, _key: string, cost: number) => {
    count += cost;
    return [{ count, window_start: new Date() }];
  });
}

describe('checkRateLimit — every call is counted (R-175)', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it('sends one upsert per call, even far below the limit', async () => {
    countingDb();
    for (let i = 0; i < 10; i++) expect(await checkRateLimit('k', { max: 100, windowSecs: 60 })).toBe(true);

    expect(sqlMock).toHaveBeenCalledTimes(10);
  });

  it('admits exactly max of 70 calls on one process', async () => {
    countingDb();
    let admitted = 0;
    for (let i = 0; i < 70; i++) if (await checkRateLimit('k', { max: 20, windowSecs: 60 })) admitted++;

    expect(admitted).toBe(20);
    expect(sqlMock).toHaveBeenCalledTimes(70);
  });

  it('admits at max and refuses at max + 1', async () => {
    sqlMock.mockResolvedValueOnce([{ count: 20, window_start: new Date() }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(true);
    sqlMock.mockResolvedValueOnce([{ count: 21, window_start: new Date() }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(false);
  });

  it('charges the clamped cost', async () => {
    countingDb();
    await checkRateLimit('k', { max: 100, windowSecs: 60, cost: 7 });
    await checkRateLimit('k', { max: 100, windowSecs: 60, cost: -3 });

    expect(sqlMock.mock.calls.map((call) => call[2])).toEqual([7, 1]);
  });

  it('a refusal is not remembered: the next call asks the database again', async () => {
    sqlMock.mockResolvedValueOnce([{ count: 21, window_start: new Date() }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(false);
    // The window rolled over, or the units were refunded by another process.
    sqlMock.mockResolvedValueOnce([{ count: 1, window_start: new Date() }]);
    expect(await checkRateLimit('k', { max: 20, windowSecs: 60 })).toBe(true);
  });

  it('refundRateLimit and clearRateLimitCache still work', async () => {
    sqlMock.mockResolvedValue([]);
    await refundRateLimit('k', 2);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls[0]![1]).toBe(2);
    expect(() => clearRateLimitCache()).not.toThrow();
  });
});
