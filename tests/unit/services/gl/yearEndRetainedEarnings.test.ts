/**
 * Year-end close must resolve retained earnings from the system-account
 * resolver, never from an account name.
 *
 * The previous lookup was
 *   WHERE account_code = ${reAccountCode} OR account_name ILIKE '%retained earnings%'
 * wrapped around a default of '3200' and an `app_settings` override that is not
 * company-scoped and holds no such key in production. This is a ledger-writing
 * path: a name match would post an entire year's closing entry to whatever
 * account somebody happened to call "Retained Earnings". Brightsphere has two
 * accounts with a retained_earnings subtype and only one flagged
 * is_system_account, so "first row that matches the name" was genuinely
 * ambiguous there.
 *
 * Every company in production has exactly one is_system_account retained
 * earnings row, so the resolver resolves cleanly for all of them — and where it
 * cannot, the close must refuse before writing anything rather than guess.
 *
 * DB is mocked — no live connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const withTransactionMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
  withTransaction: (fn: unknown) => withTransactionMock(fn),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const getSystemAccountCandidatesMock = vi.fn();
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', async (importOriginal) => ({
  // Spread the real module rather than enumerating exports: a partial mock that
  // hand-lists them breaks the moment the module gains one, and it fails
  // looking like the production code is broken instead of the mock being stale.
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/systemAccountResolver')>()),
  getSystemAccountCandidates: (...a: unknown[]) => getSystemAccountCandidatesMock(...a),
}));

const reAccount = (id: string, accountCode: string) => ({
  id, accountCode, accountName: 'Retained Earnings',
  accountType: 'equity', accountSubtype: 'retained_earnings', createdAt: 0,
});

import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

/** Queries with SQL comments stripped, so assertions read the query, not prose. */
function queryTexts(): string[] {
  return sqlMock.mock.calls.map((c) =>
    (c[0] as readonly string[])
      .join(' ? ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' '),
  );
}

/**
 * Drives the service to the retained-earnings resolution with a clean year.
 *
 * The open-period probe returns the open period ROWS, not a count — an agent
 * cannot act on "3 periods are open" and can act on their names. And the close
 * now reads `companies.financial_year_start` to check that the periods it is
 * about to close actually ARE the company's fiscal year: 1 Mar 2025 to
 * 28 Feb 2026 IS FY2026 on a March start, so this fixture passes that guard.
 */
function primeSqlToStepFive() {
  let call = 0;
  sqlMock.mockImplementation(async () => {
    call += 1;
    if (call === 1) return [];                                             // no open periods
    if (call === 2) return [{ start_date: '2025-03-01', end_date: '2026-02-28' }];
    if (call === 3) return [{ financial_year_start: 3 }];
    if (call === 4) return [{ id: 'rev-1', account_code: '4000', account_name: 'Sales', balance: '1000' }];
    if (call === 5) return [{ id: 'exp-1', account_code: '5000', account_name: 'Rent', balance: '400' }];
    // The fiscal period covering the closing date, resolved before the write
    // transaction opens: a NULL fiscal_period_id would leave the year-end
    // journal outside the trial balance permanently, and the next statement
    // locks every period in the year.
    return [{ id: 'fp-closing' }];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  withTransactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = vi.fn(async () => [{ id: 'je-1', entry_number: 'YE-2026' }]);
    return fn(tx);
  });
});

describe('closeFiscalYear — retained earnings resolution', () => {
  it('resolves retained earnings through the system-account resolver', async () => {
    primeSqlToStepFive();
    getSystemAccountCandidatesMock.mockResolvedValue([reAccount('re-account-id', '3200')]);

    await closeFiscalYear(COMPANY, '2026', USER);

    expect(getSystemAccountCandidatesMock).toHaveBeenCalledWith('retained_earnings', COMPANY);
  });

  it('never matches an account by name, code default, or app_settings', async () => {
    primeSqlToStepFive();
    getSystemAccountCandidatesMock.mockResolvedValue([reAccount('re-account-id', '3200')]);

    await closeFiscalYear(COMPANY, '2026', USER);

    for (const t of queryTexts()) {
      expect(t).not.toMatch(/account_name\s+I?LIKE/i);
      expect(t).not.toMatch(/app_settings/);
      expect(t).not.toMatch(/retained_earnings_account/);
    }
    // The hard-coded '3200' default must not be a query parameter either.
    const params = sqlMock.mock.calls.flatMap((c) => c.slice(1));
    expect(params).not.toContain('3200');
  });

  it('refuses before writing anything when no system account is configured', async () => {
    primeSqlToStepFive();
    getSystemAccountCandidatesMock.mockResolvedValue([]);

    const result = await closeFiscalYear(COMPANY, '2026', USER);

    expect(result).toMatchObject({ error: 'no_retained_earnings' });
    // Refusal before write: the closing journal transaction must never open.
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses when two system accounts both claim retained earnings', async () => {
    // A year-end close posts an entire year's profit in one entry. A
    // deterministic-but-arbitrary pick between two candidates puts the balance
    // sheet wrong for the year with only a log.error as the record — so this
    // caller refuses where the general resolver deliberately does not.
    primeSqlToStepFive();
    getSystemAccountCandidatesMock.mockResolvedValue([
      reAccount('re-1', 'SYS11'),
      reAccount('re-2', '3200'),
    ]);

    const result = await closeFiscalYear(COMPANY, '2026', USER);

    expect(result).toMatchObject({ error: 'ambiguous_retained_earnings' });
    // Both codes must be named — the user has to know which two to choose between.
    expect((result as { accountCodes: string[] }).accountCodes.sort()).toEqual(['3200', 'SYS11']);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses on three claimants too, naming all of them', async () => {
    // Test Company E2E's production shape.
    primeSqlToStepFive();
    getSystemAccountCandidatesMock.mockResolvedValue([
      reAccount('re-1', 'SYS11'), reAccount('re-2', '3200'), reAccount('re-3', '3201'),
    ]);

    const result = await closeFiscalYear(COMPANY, '2026', USER);

    expect(result).toMatchObject({ error: 'ambiguous_retained_earnings' });
    expect((result as { accountCodes: string[] }).accountCodes).toHaveLength(3);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('closes normally when exactly one account claims the role', async () => {
    primeSqlToStepFive();
    getSystemAccountCandidatesMock.mockResolvedValue([reAccount('re-1', '3200')]);

    const result = await closeFiscalYear(COMPANY, '2026', USER);

    expect(result).not.toHaveProperty('error');
    expect(withTransactionMock).toHaveBeenCalled();
  });
});
