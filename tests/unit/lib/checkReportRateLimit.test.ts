/**
 * checkReportRateLimit — per-company throttle helper for heavy report/
 * export/PDF endpoints (pentest MEDIUM resource-exhaustion DoS fix).
 * Verifies it derives the correct namespaced key, applies the documented
 * defaults (25 requests / 900s), forwards overrides, and surfaces the
 * underlying limiter's allow/deny decision — by driving the real
 * checkRateLimit through a mocked limiter pool (its only DB dependency).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const sqlMock = vi.fn();
vi.mock('@/lib/rateLimitPool', () => ({
  getRateLimitPool: () => ({ query: async (...args: unknown[]) => ({ rows: await sqlMock(...args) }) }),
}));

import { checkReportRateLimit, clearRateLimitCache } from '@/lib/rateLimit';

const verdict = (admitted: boolean, count: number) => [{ admitted, count, window_start: '2026-10-01 10:00:00+00', remaining_ms: 60_000 }];

/** The query's second arg is its parameter list; `key` is the first parameter. */
function keyFromLastCall(): string {
  const call = sqlMock.mock.calls[sqlMock.mock.calls.length - 1]!;
  return (call[1] as unknown[])[0] as string;
}

describe('checkReportRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRateLimitCache();
    sqlMock.mockResolvedValue(verdict(true, 1));
  });

  it('namespaces the key as report:<name>:co:<companyId>', async () => {
    await checkReportRateLimit('company-abc', 'reports-pdf');
    expect(keyFromLastCall()).toBe('report:reports-pdf:co:company-abc');
  });

  it('defaults to allow when under the 25-request / 900s window', async () => {
    sqlMock.mockResolvedValue(verdict(true, 10));
    const allowed = await checkReportRateLimit('company-abc', 'audit-log-export');
    expect(allowed).toBe(true);
  });

  it('denies once the default max (25) is exceeded', async () => {
    sqlMock.mockResolvedValue(verdict(false, 25));
    const allowed = await checkReportRateLimit('company-abc', 'audit-log-export');
    expect(allowed).toBe(false);
  });

  it('forwards explicit max/windowSecs overrides to the underlying limiter', async () => {
    // The statement decides against the max it is handed: fits under 10, not under 5.
    sqlMock.mockImplementation(async (_text: string, [, cost, , max]: [string, number, number, number]) => verdict(5 + cost <= max, 5));
    const allowedAtDefault = await checkReportRateLimit('company-abc', 'reports-pdf', { max: 10 });
    expect(allowedAtDefault).toBe(true);
    clearRateLimitCache();
    const deniedWithTighterMax = await checkReportRateLimit('company-abc', 'reports-pdf', { max: 5, windowSecs: 120 });
    expect(deniedWithTighterMax).toBe(false);
    const charges = sqlMock.mock.calls.filter((c) => String(c[0]).startsWith('WITH charged'));
    expect(charges.map((c) => (c[1] as unknown[]).slice(2))).toEqual([[900, 10], [120, 5]]);
  });

  it('scopes independent companies to independent keys', async () => {
    await checkReportRateLimit('company-a', 'reports-pdf');
    expect(keyFromLastCall()).toBe('report:reports-pdf:co:company-a');
    await checkReportRateLimit('company-b', 'reports-pdf');
    expect(keyFromLastCall()).toBe('report:reports-pdf:co:company-b');
  });
});
