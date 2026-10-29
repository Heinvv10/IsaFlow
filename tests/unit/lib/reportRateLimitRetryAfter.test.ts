/**
 * How long a refused report request must wait (browser review r1 M1): the seconds left in the
 * company's report window, read from rate_limit_counters on the refused path only, clamped to
 * [1, window]. A key the database no longer has waits the whole window (never "0 seconds").
 * The interactive report limit is sized for a page whose controls each reload it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/rateLimitPool', () => ({ getRateLimitPool: () => ({ query }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { INTERACTIVE_REPORT_LIMIT, reportRateLimitRetryAfter } from '@/lib/rateLimit';

beforeEach(() => { query.mockReset(); });

describe('reportRateLimitRetryAfter', () => {
  it("reads the company's report key and returns the seconds left", async () => {
    query.mockResolvedValueOnce({ rows: [{ secs: 312 }] });
    expect(await reportRateLimitRetryAfter('co-1', 'reports-budget-tracking', 900)).toBe(312);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM rate_limit_counters WHERE key = $1'), ['report:reports-budget-tracking:co:co-1', 900]);
  });

  it.each([[[], 900], [[{ secs: null }], 900], [[{ secs: 0 }], 1], [[{ secs: -5 }], 1], [[{ secs: 5000 }], 900]])('rows %j wait %i s', async (rows, want) => {
    query.mockResolvedValueOnce({ rows });
    expect(await reportRateLimitRetryAfter('co-1', 'x', 900)).toBe(want);
  });

  it('the interactive limit is 120 a company per 15 minutes', () => {
    expect(INTERACTIVE_REPORT_LIMIT).toEqual({ max: 120, windowSecs: 900 });
  });
});
