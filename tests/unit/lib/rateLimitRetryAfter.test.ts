/**
 * A refusal knows how long to wait (PR-B review r2 N2): `chargeRateLimit` returns `retryAfterMs`
 * on a refusal, from the `remaining_ms` its own statements already read, so a caller can set
 * Retry-After without a query of its own. Additive: an admission carries none, and the fields
 * every other caller reads (`admitted`, `windowStart`) are unchanged. A refusal remembered in
 * memory still knows its wait, and costs no query. `chargeReportRateLimit` turns it into whole
 * seconds for a report route, with no extra read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const query = vi.fn();
vi.mock('@/lib/rateLimitPool', () => ({ getRateLimitPool: () => ({ query }) }));

import { chargeRateLimit, chargeReportRateLimit, checkReportRateLimit, clearRateLimitCache } from '@/lib/rateLimit';

const row = (admitted: boolean, count: number, remaining_ms: number) => ({ rows: [{ admitted, count, window_start: '2026-10-29 10:00:00+00', remaining_ms }] });
const OPTS = { max: 5, windowSecs: 900 };

beforeEach(() => { query.mockReset(); clearRateLimitCache(); });

describe('chargeRateLimit retryAfterMs', () => {
  it('an admission carries no wait, and its fields are as before', async () => {
    query.mockResolvedValueOnce(row(true, 1, 899_000));
    expect(await chargeRateLimit('k', OPTS)).toEqual({ admitted: true, windowStart: '2026-10-29 10:00:00+00' });
  });

  it('a refusal with room left for a smaller call: the wait from the one statement, no other query', async () => {
    query.mockResolvedValueOnce(row(false, 3, 120_000));
    const r = await chargeRateLimit('k', { ...OPTS, cost: 3 });
    expect([r.admitted, r.windowStart]).toEqual([false, null]);
    expect(r.retryAfterMs).toBeGreaterThan(119_000);
    expect(r.retryAfterMs).toBeLessThanOrEqual(120_000);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('a full key: the wait from the latest count it already re-reads; then remembered, with its wait, for no query', async () => {
    query.mockResolvedValueOnce(row(false, 5, 240_000)).mockResolvedValueOnce({ rows: [{ count: 5, window_start: 'x', remaining_ms: 239_000 }] });
    const first = await chargeRateLimit('k', OPTS);
    expect(first.retryAfterMs).toBeGreaterThan(238_000);
    expect(query).toHaveBeenCalledTimes(2);
    const again = await chargeRateLimit('k', OPTS);
    expect(again.admitted).toBe(false);
    expect(again.retryAfterMs).toBeGreaterThan(230_000);
    expect(again.retryAfterMs).toBeLessThanOrEqual(239_000);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('chargeReportRateLimit', () => {
  // A report call costs 1, so a refusal is a FULL key: the core re-reads the latest count (its own
  // statement, there before this change). The report helper adds no query to that.
  const full = (remaining: number) => {
    query.mockResolvedValueOnce(row(false, 3, remaining)).mockResolvedValueOnce({ rows: [{ count: 3, window_start: 'x', remaining_ms: remaining }] });
  };

  it("whole seconds from the core's own reading, with no query beyond checkReportRateLimit's", async () => {
    full(61_200);
    expect(await checkReportRateLimit('co-1', 'reports-budget-tracking', { max: 3, windowSecs: 900 })).toBe(false);
    const checkQueries = query.mock.calls.length;
    query.mockReset(); clearRateLimitCache();
    full(61_200);
    expect(await chargeReportRateLimit('co-1', 'reports-budget-tracking', { max: 3, windowSecs: 900 }))
      .toEqual({ admitted: false, retryAfterSecs: 62 });
    expect(query.mock.calls.length).toBe(checkQueries);
    expect(query.mock.calls[0]![1][0]).toBe('report:reports-budget-tracking:co:co-1');
  });

  it('a window that has just ended is never "0 seconds": the wait is at least 1 (review r3 L2)', async () => {
    full(0);
    expect((await chargeReportRateLimit('co-1', 'z', { max: 3, windowSecs: 900 })).retryAfterSecs).toBe(1);
  });

  it('an admission has no wait; a wait past the window is the window', async () => {
    query.mockResolvedValueOnce(row(true, 1, 899_000));
    expect(await chargeReportRateLimit('co-1', 'x')).toEqual({ admitted: true, retryAfterSecs: null });
    full(5_000_000);
    expect((await chargeReportRateLimit('co-1', 'y', { max: 3, windowSecs: 900 })).retryAfterSecs).toBe(900);
  });
});

describe('INTERACTIVE_REPORT_LIMIT', () => {
  it('is 120 a company per 15 minutes', async () => {
    const { INTERACTIVE_REPORT_LIMIT } = await import('@/lib/rateLimit');
    expect(INTERACTIVE_REPORT_LIMIT).toEqual({ max: 120, windowSecs: 900 });
  });
});
