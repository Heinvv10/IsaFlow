/**
 * The landing page's live stats: the shared DB aggregate and its formatting.
 * getLandingStats is read by both GET /api/landing-stats and the landing
 * page's getStaticProps, so a DB failure must come back as null, never a throw
 * (a throw would fail `next build` when no DB is reachable).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const logError = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => sqlMock(strings.join('?'), ...values),
}));
vi.mock('@/lib/logger', () => ({ log: { error: (...a: unknown[]) => logError(...a), warn: vi.fn(), info: vi.fn() } }));

import { getLandingStats } from '@/lib/landing/landingStats';
import { formatRand, formatCount, buildStats } from '@/lib/landing/landingStatsFormat';

/** pg returns NUMERIC / COUNT(*) as strings; the function must coerce them. */
function answerQueries(): void {
  sqlMock.mockImplementation(async (text: string) => {
    if (text.includes('FROM bank_transactions')) return [{ total: '146234567.89' }];
    if (text.includes('FROM companies')) return [{ cnt: '7' }];
    if (text.includes('customer_invoices')) return [{ cnt: '6612' }];
    throw new Error(`unexpected query: ${text}`);
  });
}

beforeEach(() => {
  sqlMock.mockReset();
  logError.mockReset();
});

describe('formatRand', () => {
  it.each([
    [2_345_678_901, 'R 2.3B+'],
    [1_000_000_000, 'R 1.0B+'],
    [146_234_567.89, 'R 146M+'],
    [1_000_000, 'R 1M+'],
    [12_345, 'R 12K+'],
    [999, 'R 999'],
    [0, 'R 0'],
  ])('%d → %s', (amount, expected) => {
    expect(formatRand(amount)).toBe(expected);
  });
});

describe('formatCount', () => {
  it.each([
    [6612, '6.6K+'],
    [1000, '1.0K+'],
    [999, '999+'],
    [7, '7+'],
    [0, '0+'],
  ])('%d → %s', (n, expected) => {
    expect(formatCount(n)).toBe(expected);
  });
});

describe('buildStats', () => {
  it('labels the three aggregates in order', () => {
    expect(buildStats({ transactionAmount: 146_234_567.89, businessCount: 7, invoiceCount: 6612 })).toEqual([
      { value: 'R 146M+', label: 'Transactions Processed' },
      { value: '7+', label: 'Businesses' },
      { value: '6.6K+', label: 'Invoices Processed' },
    ]);
  });
});

describe('getLandingStats', () => {
  it('returns the three aggregates as numbers', async () => {
    answerQueries();
    await expect(getLandingStats()).resolves.toEqual({
      transactionAmount: 146234567.89,
      businessCount: 7,
      invoiceCount: 6612,
    });
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the query definitions: posted lines only, gross ABS amount, test companies excluded', async () => {
    answerQueries();
    await getLandingStats();
    const texts = sqlMock.mock.calls.map((c) => String(c[0]));
    expect(texts).toContainEqual(expect.stringContaining("SUM(ABS(amount)), 0) AS total FROM bank_transactions WHERE feed_state = 'posted'"));
    const companies = texts.find((t) => t.includes('FROM companies')) ?? '';
    for (const pattern of ["'Test%'", "'%E2E%'", "'STRESS%'", "'LARGE%'", "'My Test%'", "'QA%'", "'ISAFlow Demo%'"]) {
      expect(companies).toContain(`name NOT LIKE ${pattern}`);
    }
    const invoices = texts.find((t) => t.includes('customer_invoices')) ?? '';
    expect(invoices).toContain('(SELECT COUNT(*) FROM customer_invoices) +');
    expect(invoices).toContain('(SELECT COUNT(*) FROM supplier_invoices) AS cnt');
  });

  it('treats an empty result as zero', async () => {
    sqlMock.mockResolvedValue([]);
    await expect(getLandingStats()).resolves.toEqual({ transactionAmount: 0, businessCount: 0, invoiceCount: 0 });
  });

  it('returns null and logs, without throwing, when the DB fails', async () => {
    sqlMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(getLandingStats()).resolves.toBeNull();
    expect(logError).toHaveBeenCalledWith('landing-stats failed', { message: 'connect ECONNREFUSED' }, 'LandingStats');
  });
});
