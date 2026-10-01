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

/** The query's second arg is its parameter list; `key` is the first parameter. */
function keyFromLastCall(): string {
  const call = sqlMock.mock.calls[sqlMock.mock.calls.length - 1]!;
  return (call[1] as unknown[])[0] as string;
}

describe('checkReportRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRateLimitCache();
    sqlMock.mockResolvedValue([{ count: 1, window_start: new Date() }]);
  });

  it('namespaces the key as report:<name>:co:<companyId>', async () => {
    await checkReportRateLimit('company-abc', 'reports-pdf');
    expect(keyFromLastCall()).toBe('report:reports-pdf:co:company-abc');
  });

  it('defaults to allow when under the 25-request / 900s window', async () => {
    sqlMock.mockResolvedValue([{ count: 10, window_start: new Date() }]);
    const allowed = await checkReportRateLimit('company-abc', 'audit-log-export');
    expect(allowed).toBe(true);
  });

  it('denies once the default max (25) is exceeded', async () => {
    sqlMock.mockResolvedValue([{ count: 26, window_start: new Date() }]);
    const allowed = await checkReportRateLimit('company-abc', 'audit-log-export');
    expect(allowed).toBe(false);
  });

  it('forwards explicit max/windowSecs overrides to the underlying limiter', async () => {
    sqlMock.mockResolvedValue([{ count: 6, window_start: new Date() }]);
    const allowedAtDefault = await checkReportRateLimit('company-abc', 'reports-pdf', { max: 10 });
    expect(allowedAtDefault).toBe(true);
    clearRateLimitCache();
    const deniedWithTighterMax = await checkReportRateLimit('company-abc', 'reports-pdf', { max: 5 });
    expect(deniedWithTighterMax).toBe(false);
  });

  it('scopes independent companies to independent keys', async () => {
    await checkReportRateLimit('company-a', 'reports-pdf');
    expect(keyFromLastCall()).toBe('report:reports-pdf:co:company-a');
    await checkReportRateLimit('company-b', 'reports-pdf');
    expect(keyFromLastCall()).toBe('report:reports-pdf:co:company-b');
  });
});
