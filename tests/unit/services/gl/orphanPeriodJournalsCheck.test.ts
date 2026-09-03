/**
 * A journal with a NULL `fiscal_period_id` is an INVISIBLE journal.
 *
 * It posts, it balances, and it appears in no period report — not the trial
 * balance, not the VAT201, not the AFS. Migration 501 names the cost of the
 * last outbreak: Britech's R267,109.70 salary understatement, with 200+ more
 * rows at the time.
 *
 * `createJournalEntry` resolves the period, and `ensureFiscalPeriodForDate`
 * creates the year on demand when it cannot. But two paths INSERT into
 * `gl_journal_entries` directly and bypass both — the depreciation hook
 * (`glCrossModuleHooks.ts`, live, dating entries `CURRENT_DATE`) and the
 * year-end close. Neither can invent a period that does not exist, and every
 * production company's periods stop at 2027-12-31.
 *
 * This check is COMPANY-scoped, not period-scoped, and that is the whole point:
 * an orphan journal belongs to no period, so no period-scoped query can ever
 * find it. Every close is the right place to ask, because a close asserts that
 * a period is complete and an invisible journal is precisely what that
 * assertion cannot see.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { orphanPeriodJournalsCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/orphanPeriodJournalsCheck';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function sqlText(): string {
  const parts = mockSql.mock.calls[0]?.[0] as TemplateStringsArray | undefined;
  return (parts ?? ([] as unknown as TemplateStringsArray)).join(' ? ');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  mockSql.mockResolvedValue([{ orphan_count: '0', earliest: null, latest: null, total: '0' }]);
});

describe('orphanPeriodJournalsCheck', () => {
  it('passes when every journal belongs to a period', async () => {
    mockSql.mockResolvedValue([{ orphan_count: '0', earliest: null, latest: null, total: '0' }]);
    const item = await orphanPeriodJournalsCheck(COMPANY);
    expect(item).toMatchObject({ key: 'orphan_period_journals', status: 'pass' });
  });

  it('FAILS — not warns — when any journal has no period', async () => {
    // A close must not step over this. The period being closed cannot account
    // for a journal that is in no period, so the assertion the close makes is
    // false by construction.
    mockSql.mockResolvedValue([
      { orphan_count: '3', earliest: '2028-01-31', latest: '2028-03-31', total: '12500.00' },
    ]);
    const item = await orphanPeriodJournalsCheck(COMPANY);
    expect(item.status).toBe('fail');
  });

  it('reports the count, the date range AND the value', async () => {
    // "Three journals were dropped" and "R12,500 was dropped" are different
    // facts, and only the second tells a reader whether to care.
    mockSql.mockResolvedValue([
      { orphan_count: '3', earliest: '2028-01-31', latest: '2028-03-31', total: '12500.00' },
    ]);
    const item = await orphanPeriodJournalsCheck(COMPANY);
    expect(item.reason).toMatch(/3/);
    expect(item.reason).toMatch(/2028-01-31/);
    expect(item.reason).toMatch(/2028-03-31/);
    expect(item.reason).toMatch(/R12500\.00/);
  });

  it('counts POSTED journals only — a draft is caught by unposted_journals', async () => {
    await orphanPeriodJournalsCheck(COMPANY);
    expect(sqlText()).toMatch(/status\s*=\s*'posted'/);
  });

  it('is company-scoped and NOT period-scoped — an orphan belongs to no period', async () => {
    await orphanPeriodJournalsCheck(COMPANY);
    expect(sqlText()).toMatch(/company_id/);
    expect(sqlText()).toMatch(/fiscal_period_id IS NULL/);
    expect(mockSql.mock.calls[0]?.slice(1)).toContain(COMPANY);
  });

  it('handles a Date from pg for the boundary dates', async () => {
    mockSql.mockResolvedValue([{
      orphan_count: '1',
      earliest: new Date('2028-01-31T00:00:00Z'),
      latest: new Date('2028-01-31T00:00:00Z'),
      total: '1.00',
    }]);
    const item = await orphanPeriodJournalsCheck(COMPANY);
    expect(item.reason).toMatch(/2028-01-31/);
  });

  it('points at the journal listing so the reader can go and look', async () => {
    mockSql.mockResolvedValue([
      { orphan_count: '1', earliest: '2028-01-31', latest: '2028-01-31', total: '1.00' },
    ]);
    const item = await orphanPeriodJournalsCheck(COMPANY);
    expect(item.fixHref).toMatch(/journal/);
  });
});
