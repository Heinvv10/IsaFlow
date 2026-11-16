/**
 * `closeFiscalYear` and the period-close readiness gate (PR #1451): the early
 * status read, the dry run's gate (under the same lock budget as the live
 * close), the in-transaction gate's typed refusals, and the busy message.
 * Split out of yearEndCloseDryRun.test.ts (300-line cap); same harness.
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
vi.mock('@/modules/accounting/services/gl/yearEndPeriodGate', async (orig) => (await import('../../helpers/yearEndGateMocks')).yearEndPeriodGateMock(orig));
vi.mock('@/modules/accounting/services/gl/periodCloseGate', async () => (await import('../../helpers/yearEndGateMocks')).periodCloseGateMock());
// The year's real dates are the registry's (a stored fiscal_years row), not the declared start month.
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../../helpers/fiscalYearSqlFake')).registryMock());
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountCandidates: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { getSystemAccountCandidates } from '@/modules/accounting/services/gl/systemAccountResolver';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndService';
import { fakeRegistry, resetFakeRegistry, type FakeYear } from '../../../helpers/fiscalYearSqlFake';
import { assertYearCloseReady, withPeriodLockBudget } from '@/modules/accounting/services/gl/periodCloseGate';
import { YearCloseBlockedError } from '@/modules/accounting/services/gl/periodCloseErrors';
import { lockAndJudgeYear, YearEndPeriodsNotClosedError } from '@/modules/accounting/services/gl/yearEndPeriodGate';

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

describe('closeFiscalYear — the periods it locks are judged (B1 / B2, 2026-11-15)', () => {
  const BANK = { key: 'bank_reconciled' as const, label: 'Bank reconciled', reason: '1 unreconciled', fixHref: '/accounting/bank-transactions' };
  const refusal = () => new YearCloseBlockedError(2027, [{ periodId: 'fp-3', periodName: 'May 2026', blockers: [BANK] }], 'locked');

  it('T2: the early read counts every period not closed or locked — closing and NULL too — as open', async () => {
    mockSql.mockResolvedValueOnce([{ id: 'p1', period_name: 'March 2026', period_number: 1 }]);
    await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(sqlText(0)).toMatch(/AND \(status IS NULL OR status NOT IN \('closed', 'locked'\)\)/);
  });

  it('dry run: a closed period that fails a check is close_checks_failed, named — what the live call would answer', async () => {
    mockReads();
    vi.mocked(assertYearCloseReady).mockRejectedValueOnce(refusal());
    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(result).toEqual({ error: 'close_checks_failed', fiscalYear: 2027, periods: [{ periodId: 'fp-3', periodName: 'May 2026', blockers: [BANK] }] });
    expect(vi.mocked(assertYearCloseReady).mock.calls[0]![4]).toBe('locked');
  });

  it('live: the in-transaction gate refusal is close_checks_failed, and no journal is written', async () => {
    mockReads();
    vi.mocked(lockAndJudgeYear).mockRejectedValueOnce(refusal());
    const result = await closeFiscalYear(COMPANY, '2027', USER);
    expect(result).toMatchObject({ error: 'close_checks_failed', fiscalYear: 2027 });
    expect(writes.filter((w) => w.includes('INSERT'))).toEqual([]);
  });

  it('3a: the live close runs under the lock budget, and a busy answer names every lock it can wait on', async () => {
    mockReads();
    await closeFiscalYear(COMPANY, '2027', USER);
    expect(withPeriodLockBudget).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withPeriodLockBudget).mock.calls[0]![1]).toMatch(/fiscal periods, the financial year, the VAT period lock or the journal numbering lock/);
  });

  it('live: a period reopened after the early read is open_periods, named, and nothing is written', async () => {
    mockReads();
    vi.mocked(lockAndJudgeYear).mockRejectedValueOnce(
      new YearEndPeriodsNotClosedError([{ id: 'fp-12', periodName: 'February 2027', periodNumber: 12 }]));
    const result = await closeFiscalYear(COMPANY, '2027', USER);
    expect(result).toEqual({ error: 'open_periods', count: 1, openPeriods: [{ id: 'fp-12', periodName: 'February 2027', periodNumber: 12 }] });
    expect(writes.filter((w) => w.includes('INSERT'))).toEqual([]);
  });
});

describe('closeFiscalYear — N3: the dry run judges under the same lock budget as the live close', () => {
  it('the dry run runs its readiness gate inside withPeriodLockBudget, naming the year-end locks', async () => {
    mockReads();
    let gateInBudget = false;
    let inBudget = false;
    vi.mocked(withPeriodLockBudget).mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      inBudget = true;
      try { return await fn(); } finally { inBudget = false; }
    });
    vi.mocked(assertYearCloseReady).mockImplementationOnce(async () => { gateInBudget = inBudget; });
    await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(gateInBudget).toBe(true);
    expect(vi.mocked(withPeriodLockBudget).mock.calls[0]![1]).toMatch(/fiscal periods, the financial year/);
  });
});
