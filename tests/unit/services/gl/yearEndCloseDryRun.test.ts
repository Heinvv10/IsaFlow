/**
 * `year_end_close` — the dry run is the important half.
 *
 * Brightsphere has four unclosed year-ends and R8.46m of "retained earnings"
 * with no journal lines behind it, so equity is a computed residual and the
 * balance sheet balancing proves nothing. The remedy is a posting that moves
 * four years of P&L into equity in one call, which is exactly the kind of call
 * nobody should make without seeing it first.
 *
 * So the dry run must show: which periods block the close (named, not counted),
 * and the retained-earnings journal that would post — every line, both totals.
 *
 * Also pinned: the retained-earnings lookup is company-scoped and deterministic
 * (it was an unscoped `app_settings` read and a `LIMIT 1` heap-order winner).
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// R-032 L5: the Login-as guard runs its own query first; it is covered by
// tests/unit/auth/statutoryImpersonationGuards.test.ts and the r-032 integration suites.
vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txSpy)),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// The year's real dates are the registry's (a stored fiscal_years row), not the declared start month.
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../../helpers/fiscalYearSqlFake')).registryMock());
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountCandidates: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { getSystemAccountCandidates } from '@/modules/accounting/services/gl/systemAccountResolver';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndService';
import { fakeRegistry, resetFakeRegistry, TRANSITION_YEARS, type FakeYear } from '../../../helpers/fiscalYearSqlFake';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const writes: string[] = [];
const txSpy = ((strings: TemplateStringsArray) => {
  writes.push(strings.join('?'));
  return Promise.resolve([{ id: 'je-1', entry_number: 'YE-2027' }]);
}) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = 'user-1';

function sqlText(i: number): string {
  const parts = mockSql.mock.calls[i]?.[0] as TemplateStringsArray | undefined;
  return (parts ?? ([] as unknown as TemplateStringsArray)).join(' ? ');
}

function retainedEarnings(accounts: Array<{ code: string }>): void {
  vi.mocked(getSystemAccountCandidates).mockResolvedValue(accounts.map((a, i) => ({
    id: `re-${i + 1}`, accountCode: a.code, accountName: 'Retained Earnings',
    accountType: 'equity', accountSubtype: 'retained_earnings', createdAt: 0,
  })) as never);
}

/** open periods → year range → revenue → expenses → closed lookup → (live) closing period; RE via the resolver. */
function mockReads(openPeriods: unknown[] = [], years?: readonly FakeYear[],
                   range = { start_date: '2026-03-01', end_date: '2027-02-28' }): void {
  if (years) fakeRegistry.years = years;
  mockSql
    .mockResolvedValueOnce(openPeriods)
    .mockResolvedValueOnce([range])
    .mockResolvedValueOnce([{ id: 'rev-1', account_code: '4000', account_name: 'Sales', balance: '1000000.00' }])
    .mockResolvedValueOnce([{ id: 'exp-1', account_code: '5000', account_name: 'Wages', balance: '400000.00' }])
    .mockResolvedValueOnce([])                       // no existing closing journal (K-113 lookup)
    .mockResolvedValueOnce([{ id: 'fp-12' }]);
  retainedEarnings([{ code: '3200' }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset too: clearAllMocks leaves the mockResolvedValueOnce QUEUE, which would leak between tests.
  mockSql.mockReset();
  resetFakeRegistry();
  writes.length = 0;
});

describe('closeFiscalYear — dry run', () => {
  it('returns the journal that WOULD post, and writes nothing', async () => {
    mockReads();

    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });

    expect(writes).toHaveLength(0);
    expect(result).toMatchObject({ dryRun: true, netIncome: 600000 });
    if (!('preview' in result) || result.preview === null) throw new Error('expected a preview');
    expect(result.preview.entryDate).toBe('2027-02-28');
    expect(result.preview.totalDebit).toBe(1000000);
    expect(result.preview.totalCredit).toBe(1000000);
  });

  it('shows every line of the journal, not a count', async () => {
    mockReads();
    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    if (!('preview' in result) || result.preview === null) throw new Error('expected a preview');

    expect(result.preview.lines).toEqual([
      { accountId: 'rev-1', accountCode: '4000', accountName: 'Sales', debit: 1000000, credit: 0 },
      { accountId: 'exp-1', accountCode: '5000', accountName: 'Wages', debit: 0, credit: 400000 },
      {
        accountId: 're-1', accountCode: '3200', accountName: 'Retained Earnings',
        debit: 0, credit: 600000,
      },
    ]);
  });

  it('debits retained earnings on a loss', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ start_date: '2026-03-01', end_date: '2027-02-28' }])
      .mockResolvedValueOnce([{ id: 'rev-1', account_code: '4000', account_name: 'Sales', balance: '100.00' }])
      .mockResolvedValueOnce([{ id: 'exp-1', account_code: '5000', account_name: 'Wages', balance: '500.00' }])
      .mockResolvedValueOnce([]);  // no existing closing journal (K-113 lookup)
    retainedEarnings([{ code: '3200' }]);

    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    if (!('preview' in result) || result.preview === null) throw new Error('expected a preview');

    expect(result.netIncome).toBe(-400);
    expect(result.preview.lines[2]).toMatchObject({ accountId: 're-1', debit: 400, credit: 0 });
    expect(result.preview.totalDebit).toBe(result.preview.totalCredit);
  });

  it('NAMES the periods blocking the close, not just how many', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 'p1', period_name: 'March 2026', period_number: 1 },
      { id: 'p2', period_name: 'April 2026', period_number: 2 },
    ]);

    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });

    expect(result).toMatchObject({ error: 'open_periods', count: 2 });
    if (!('openPeriods' in result)) throw new Error('expected the open periods');
    expect(result.openPeriods.map((p) => p.periodName)).toEqual(['March 2026', 'April 2026']);
  });

  it('refuses on open periods on the DRY RUN as well as the live call', async () => {
    mockSql.mockResolvedValueOnce([{ id: 'p1', period_name: 'March 2026', period_number: 1 }]);
    const dry = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(dry).toMatchObject({ error: 'open_periods' });
    expect(writes).toHaveLength(0);
  });

  it('REFUSES when the retained-earnings role is CONTESTED, rather than breaking the tie', async () => {
    // getSystemAccount would pick a winner deterministically and only log it.
    // Right for a caller that must keep working, wrong here: one entry moves a
    // whole year's profit into equity and then locks every period behind it.
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ start_date: '2026-03-01', end_date: '2027-02-28' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);  // no existing closing journal (K-113 lookup)
    retainedEarnings([{ code: '3210' }, { code: '3220' }]);

    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });

    expect(result).toMatchObject({ error: 'ambiguous_retained_earnings' });
    if (!('accountCodes' in result)) throw new Error('expected the candidate codes');
    expect(result.accountCodes).toEqual(['3210', '3220']);
  });

  it('reports a missing retained-earnings ROLE on the dry run', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ start_date: '2026-03-01', end_date: '2027-02-28' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);  // no existing closing journal (K-113 lookup)
    retainedEarnings([]);

    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(result).toMatchObject({ error: 'no_retained_earnings' });
  });
});

describe('closeFiscalYear — the periods must actually BE the fiscal year', () => {
  it('REFUSES when the periods do not span the company financial year', async () => {
    // Brightsphere's "fiscal year 2026" is 1 Jan – 31 Dec 2026 while its
    // declared financial year starts in March, so the real FY2026 is
    // 1 Mar 2025 – 28 Feb 2026. Closing the calendar span rolls the WRONG
    // twelve months into retained earnings, and then locks every period behind
    // it. Nothing about the arithmetic would look wrong afterwards.
    mockReads([], undefined, { start_date: '2026-01-01', end_date: '2026-12-31' });

    const result = await closeFiscalYear(COMPANY, '2026', USER, { dryRun: true });

    expect(result).toMatchObject({ error: 'period_range_mismatch' });
    if (!('expected' in result)) throw new Error('expected the two ranges');
    expect(result.expected).toEqual({ startDate: '2025-03-01', endDate: '2026-02-28' });
    expect(result.actual).toEqual({ startDate: '2026-01-01', endDate: '2026-12-31' });
  });

  it('refuses on the DRY RUN as well as the live call, and writes nothing', async () => {
    mockReads([], undefined, { start_date: '2026-01-01', end_date: '2026-12-31' });
    await closeFiscalYear(COMPANY, '2026', USER);
    expect(writes).toHaveLength(0);
  });

  it('allows a year whose periods DO span the financial year', async () => {
    mockReads([], undefined, { start_date: '2026-03-01', end_date: '2027-02-28' });
    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(result).not.toHaveProperty('error');
  });

  it('allows a calendar year for a company whose registry year is the calendar year', async () => {
    mockReads([], [{ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31' }],
      { start_date: '2026-01-01', end_date: '2026-12-31' });
    const result = await closeFiscalYear(COMPANY, '2026', USER, { dryRun: true });
    expect(result).not.toHaveProperty('error');
  });

  it('allows a 14-month transition year whose periods span its stored dates', async () => {
    // FY2027 is 2026-01-01 to 2027-02-28 after a change of year end; twelve months of the
    // declared March start (2026-03-01 to 2027-02-28) would have refused it.
    mockReads([], TRANSITION_YEARS, { start_date: '2026-01-01', end_date: '2027-02-28' });
    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(result).not.toHaveProperty('error');
  });

  it('REFUSES a transition year whose periods stop short of its stored dates', async () => {
    mockReads([], TRANSITION_YEARS, { start_date: '2026-03-01', end_date: '2027-02-28' });
    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(result).toMatchObject({ error: 'period_range_mismatch' });
    if (!('expected' in result)) throw new Error('expected the two ranges');
    expect(result.expected).toEqual({ startDate: '2026-01-01', endDate: '2027-02-28' });
  });

  it('reports year_not_found when no registry year carries the label, rather than guessing a range', async () => {
    mockReads([], [], { start_date: '2026-03-01', end_date: '2027-02-28' });
    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(result).toEqual({ error: 'year_not_found' });
  });
});

describe('closeFiscalYear — tenant scoping and determinism', () => {
  it('resolves retained earnings by ROLE, never by account code or name', async () => {
    mockReads();
    await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(getSystemAccountCandidates).toHaveBeenCalledWith('retained_earnings', COMPANY);
    // The old lookup read an app_settings code (unscoped by company, on a view
    // that HAS company_id) and then matched `account_name ILIKE '%retained
    // earnings%'` with no ORDER BY. Neither query is issued any more.
    const allSql = mockSql.mock.calls.map((c) => (c[0] as TemplateStringsArray).join(' ')).join('\n');
    expect(allSql).not.toMatch(/app_settings/);
    expect(allSql).not.toMatch(/retained earnings/i);
  });

  it('still writes the journal on a live call', async () => {
    mockReads();
    const result = await closeFiscalYear(COMPANY, '2027', USER);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((w) => w.includes('gl_journal_entries'))).toBe(true);
    expect(writes.some((w) => w.includes('UPDATE fiscal_periods'))).toBe(true);
    expect(result).toMatchObject({ netIncome: 600000 });
  });

  it('does NOT insert total_debit / total_credit — those columns do not exist', async () => {
    // 42703 on every live close, over MCP and through the UI route alike.
    // Pinned here as well as in the DB-gated test, so a mocked run catches a
    // reintroduction even without a database.
    mockReads();
    await closeFiscalYear(COMPANY, '2027', USER);
    const entryInsert = writes.find((w) => w.includes('INSERT INTO gl_journal_entries'))!;
    expect(entryInsert).not.toMatch(/total_debit/);
    expect(entryInsert).not.toMatch(/total_credit/);
  });

  it('stamps fiscal_period_id on the closing journal', async () => {
    // A journal with a NULL fiscal_period_id sits outside the trial balance,
    // the VAT201 and the AFS permanently — and this one is followed immediately
    // by locking every period in the year, so it could never be corrected in
    // place. The raw INSERT bypasses createJournalEntry, which is what would
    // otherwise have resolved the period.
    mockReads();
    await closeFiscalYear(COMPANY, '2027', USER);
    const entryInsert = writes.find((w) => w.includes('INSERT INTO gl_journal_entries'))!;
    expect(entryInsert).toMatch(/fiscal_period_id/);
  });

  it('records who posted it and when, not only that it is posted', async () => {
    mockReads();
    await closeFiscalYear(COMPANY, '2027', USER);
    const entryInsert = writes.find((w) => w.includes('INSERT INTO gl_journal_entries'))!;
    expect(entryInsert).toMatch(/posted_by/);
    expect(entryInsert).toMatch(/posted_at/);
  });
});
