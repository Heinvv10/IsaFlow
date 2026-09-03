/**
 * Unit tests for trialBalanceService.ts
 *
 * BL-18 (F-008): `getTrialBalance` returns a plain `TrialBalanceRow[]` and the
 * API handler wraps it as `{ rows, totalDebit, totalCredit }`. The canonical
 * response container key is `rows` — never `accounts`.
 *
 * CS-01: a trial balance reports BALANCES, not one period's movement.
 * Balance-sheet accounts are cumulative from inception to the end of the
 * selected period; income-statement accounts are year-to-date within the
 * company's fiscal year (companies.financial_year_start, 3 = March in prod —
 * never a calendar year). Accounts that carry a balance appear even when they
 * did not move in the period, and the profit earned before the fiscal year is
 * folded into retained earnings so the statement still balances.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    transaction: vi.fn(),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  getTrialBalance,
  getTrialBalanceReport,
  BALANCE_TOLERANCE,
} from '@/modules/accounting/services/gl/trialBalanceService';
import {
  BROUGHT_FORWARD_CODE,
  broughtForwardLine,
  fiscalYearStart,
  splitNet,
  round2,
} from '@/modules/accounting/services/gl/trialBalanceBasis';
import type { TrialBalanceRow } from '@/modules/accounting/types/gl.types';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PERIOD_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';

/** February 2026 for a March–February fiscal year (every prod company). */
const PERIOD_META = {
  start_date: '2026-02-01',
  end_date: '2026-02-28',
  fy_start_month: 3,
};

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    account_code: '1000',
    account_name: 'Bank - Primary',
    account_type: 'asset',
    normal_balance: 'debit',
    closing_debit: '1000.00',
    closing_credit: '0.00',
    period_debit: '1000.00',
    period_credit: '0.00',
    ...overrides,
  };
}

type SqlMock = ReturnType<typeof vi.fn>;

/**
 * Queue the three queries getTrialBalance issues, in order:
 * period/fiscal-year metadata, the balance aggregate, the brought-forward profit.
 */
function primeSql(accountRows: Record<string, unknown>[], broughtForward = '0') {
  const mockSql = sql as SqlMock;
  mockSql
    .mockResolvedValueOnce([PERIOD_META])
    .mockResolvedValueOnce(accountRows)
    .mockResolvedValueOnce([{ retained: broughtForward }]);
  return mockSql;
}

/**
 * SQL text of the Nth `sql` tagged-template call, with SQL comments stripped.
 *
 * Asserting on raw template text is one edit away from a false pass: a
 * `-- no longer filtered by fiscal_period_id` comment satisfies a
 * `toContain('fiscal_period_id')` without the filter existing, and breaks a
 * `not.toContain` without the filter returning. Strip comments and the
 * assertion is about the query the database actually runs.
 */
function sqlTextOf(mockSql: SqlMock, callIndex: number): string {
  const strings = (mockSql.mock.calls[callIndex] as unknown[])[0] as string[];
  return strings
    .join(' ? ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** Values interpolated into the Nth `sql` tagged-template call (0-based). */
function paramsOf(mockSql: SqlMock, callIndex: number): unknown[] {
  return (mockSql.mock.calls[callIndex] as unknown[]).slice(1);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fiscalYearStart (CS-01 — fiscal year, never calendar year)', () => {
  it('puts February 2026 in the March 2025 fiscal year', () => {
    expect(fiscalYearStart('2026-02-28', 3)).toBe('2025-03-01');
  });

  it('starts a new fiscal year on 1 March', () => {
    expect(fiscalYearStart('2026-03-01', 3)).toBe('2026-03-01');
    expect(fiscalYearStart('2026-02-28', 3)).toBe('2025-03-01');
  });

  it('keeps December in the same fiscal year as the preceding March', () => {
    expect(fiscalYearStart('2026-12-31', 3)).toBe('2026-03-01');
  });

  it('honours a January fiscal year start', () => {
    expect(fiscalYearStart('2026-06-15', 1)).toBe('2026-01-01');
    expect(fiscalYearStart('2026-01-01', 1)).toBe('2026-01-01');
  });

  it('honours a July fiscal year start', () => {
    expect(fiscalYearStart('2026-06-30', 7)).toBe('2025-07-01');
    expect(fiscalYearStart('2026-07-01', 7)).toBe('2026-07-01');
  });

  it('falls back to March for an out-of-range or missing month', () => {
    expect(fiscalYearStart('2026-02-28', 0)).toBe('2025-03-01');
    expect(fiscalYearStart('2026-02-28', Number.NaN)).toBe('2025-03-01');
  });
});

describe('splitNet / round2', () => {
  it('reports a positive net in the debit column only', () => {
    expect(splitNet(6003472.64)).toEqual({ debit: 6003472.64, credit: 0 });
  });

  it('reports a negative net in the credit column only', () => {
    expect(splitNet(-613641.77)).toEqual({ debit: 0, credit: 613641.77 });
  });

  it('kills float noise rather than emitting a 1e-10 balance', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(splitNet(1e-11)).toEqual({ debit: 0, credit: 0 });
  });
});

describe('getTrialBalance (BL-18 shape contract)', () => {
  it('returns a plain array of TrialBalanceRow items (not an object with accounts key)', async () => {
    primeSql([makeDbRow()]);
    const result = await getTrialBalance(COMPANY_ID, PERIOD_ID);
    expect(Array.isArray(result)).toBe(true);
    expect('accounts' in result).toBe(false);
  });

  it('maps DB snake_case to camelCase TrialBalanceRow fields', async () => {
    primeSql([makeDbRow({ closing_debit: '2500.50', closing_credit: '0.00', period_debit: '2500.50' })]);
    const row = (await getTrialBalance(COMPANY_ID, PERIOD_ID))[0] as TrialBalanceRow;
    expect(row.accountCode).toBe('1000');
    expect(row.accountName).toBe('Bank - Primary');
    expect(row.accountType).toBe('asset');
    expect(row.normalBalance).toBe('debit');
    expect(row.debitBalance).toBe(2500.5);
    expect(row.creditBalance).toBe(0);
    expect('accounts' in row).toBe(false);
  });

  it('returns empty array when the company has no posted lines to date', async () => {
    primeSql([]);
    const result = await getTrialBalance(COMPANY_ID, PERIOD_ID);
    expect(result).toHaveLength(0);
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns empty array when the fiscal period does not belong to the company', async () => {
    (sql as SqlMock).mockResolvedValueOnce([]);
    expect(await getTrialBalance(COMPANY_ID, PERIOD_ID)).toEqual([]);
    // The balance query must never run without a period to bound it.
    expect((sql as SqlMock).mock.calls).toHaveLength(1);
  });

  it('API response wrapper shape uses "rows" key — not "accounts"', () => {
    const rows: TrialBalanceRow[] = [
      {
        accountCode: '1000', accountName: 'Bank', accountType: 'asset',
        normalBalance: 'debit', debitBalance: 1000, creditBalance: 0,
      },
    ];
    const totalDebit  = rows.reduce((s, r) => s + r.debitBalance, 0);
    const totalCredit = rows.reduce((s, r) => s + r.creditBalance, 0);
    const responseData = { fiscalPeriodId: PERIOD_ID, rows, totalDebit, totalCredit };
    expect('rows' in responseData).toBe(true);
    expect('accounts' in responseData).toBe(false);
    expect(responseData.rows).toHaveLength(1);
    expect(responseData.totalDebit).toBe(1000);
    expect(responseData.totalCredit).toBe(0);
  });
});

describe('getTrialBalance (CS-01 — balances, not period movement)', () => {
  it('bounds the balance query by the period END and the fiscal-year start, not by fiscal_period_id', async () => {
    const mockSql = primeSql([makeDbRow()]);
    await getTrialBalance(COMPANY_ID, PERIOD_ID);

    const params = paramsOf(mockSql, 1);
    // Fiscal-year start for Feb 2026 with financial_year_start = 3.
    expect(params).toContain('2025-03-01');
    expect(params).toContain('2026-02-01');
    expect(params).toContain('2026-02-28');
    // The period id must NOT be a filter on the balance query.
    expect(params).not.toContain(PERIOD_ID);

    expect(sqlTextOf(mockSql, 1)).not.toContain('fiscal_period_id');
  });

  it('asks for the brought-forward profit as at the fiscal-year start', async () => {
    const mockSql = primeSql([makeDbRow()]);
    await getTrialBalance(COMPANY_ID, PERIOD_ID);
    expect(paramsOf(mockSql, 2)).toContain('2025-03-01');
  });

  it('reports the cumulative bank balance, not the month it moved (Brightsphere Feb 2026)', async () => {
    primeSql([
      makeDbRow({
        account_code: '1049686', account_name: 'Brighttech Absa',
        closing_debit: '30640532.90', closing_credit: '24637060.26',
        period_debit: '229570.66', period_credit: '115727.22',
      }),
    ]);
    const row = (await getTrialBalance(COMPANY_ID, PERIOD_ID))[0] as TrialBalanceRow;
    expect(row.debitBalance).toBe(6003472.64);
    expect(row.creditBalance).toBe(0);
    // The old, wrong figure — the month's net movement.
    expect(row.debitBalance).not.toBe(113843.44);
  });

  it('reports trade debtors at their cumulative balance (Brightsphere Feb 2026)', async () => {
    primeSql([
      makeDbRow({
        account_code: '1101', account_name: 'Trade Debtors Control',
        closing_debit: '10676022.60', closing_credit: '2000224.00',
        period_debit: '305900.00', period_credit: '182050.00',
      }),
    ]);
    const row = (await getTrialBalance(COMPANY_ID, PERIOD_ID))[0] as TrialBalanceRow;
    expect(row.debitBalance).toBe(8675798.60);
    expect(row.debitBalance).not.toBe(123850);
  });

  it('puts a credit-balance account in the credit column only', async () => {
    primeSql([
      makeDbRow({
        account_code: '2001', account_name: 'Trade Creditors Control',
        account_type: 'liability', normal_balance: 'credit',
        closing_debit: '0.00', closing_credit: '613641.77',
        period_debit: '0', period_credit: '0',
      }),
    ]);
    const row = (await getTrialBalance(COMPANY_ID, PERIOD_ID))[0] as TrialBalanceRow;
    expect(row.creditBalance).toBe(613641.77);
    expect(row.debitBalance).toBe(0);
  });

  it('keeps an account that carries a balance but did not move in the period', async () => {
    primeSql([
      makeDbRow({
        account_code: '1121', account_name: 'Loan Account - Blitz Fibre',
        closing_debit: '335000.00', closing_credit: '205000.00',
        period_debit: '0', period_credit: '0',
      }),
    ]);
    const rows = await getTrialBalance(COMPANY_ID, PERIOD_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.debitBalance).toBe(130000);
    expect(rows[0]!.periodDebit).toBe(0);
    expect(rows[0]!.periodCredit).toBe(0);
  });

  it('drops an account with neither a balance nor movement in the range', async () => {
    primeSql([
      makeDbRow({ closing_debit: '0', closing_credit: '0', period_debit: '0', period_credit: '0' }),
    ]);
    expect(await getTrialBalance(COMPANY_ID, PERIOD_ID)).toHaveLength(0);
  });

  it('exposes opening balance and period movement that reconcile to the closing balance', async () => {
    primeSql([
      makeDbRow({
        closing_debit: '30640532.90', closing_credit: '24637060.26',
        period_debit: '229570.66', period_credit: '115727.22',
      }),
    ]);
    const row = (await getTrialBalance(COMPANY_ID, PERIOD_ID))[0] as TrialBalanceRow;
    expect(row.periodDebit).toBe(229570.66);
    expect(row.periodCredit).toBe(115727.22);
    expect(row.openingDebit).toBe(5889629.2);
    expect(row.openingCredit).toBe(0);
    const opening = (row.openingDebit ?? 0) - (row.openingCredit ?? 0);
    const movement = (row.periodDebit ?? 0) - (row.periodCredit ?? 0);
    const closing = row.debitBalance - row.creditBalance;
    expect(round2(opening + movement)).toBe(closing);
  });
});

describe('getTrialBalance (CS-01 — brought-forward profit keeps it balanced)', () => {
  /**
   * The ledger holds no year-end closing journals. Cutting revenue/expense back
   * to year-to-date therefore removes prior years' profit from the statement;
   * it has to reappear in equity or the trial balance no longer balances.
   */
  it('adds prior years profit as a credit on its own derived row', async () => {
    primeSql(
      [
        makeDbRow({ closing_debit: '30640532.90', closing_credit: '24637060.26', period_debit: '0', period_credit: '0' }),
      ],
      '2254813.96',
    );

    const rows = await getTrialBalance(COMPANY_ID, PERIOD_ID);
    const bf = rows.find(r => r.accountCode === BROUGHT_FORWARD_CODE);
    expect(bf).toBeDefined();
    expect(bf!.accountType).toBe('equity');
    expect(bf!.creditBalance).toBe(2254813.96);
    expect(bf!.debitBalance).toBe(0);
    expect(bf!.openingCredit).toBe(2254813.96);
  });

  /**
   * An auditor tying this report to the ledger must be able to tell which
   * figure was posted and which was computed. Merging the brought-forward
   * amount into the posted retained-earnings account hides exactly that.
   */
  it('flags the brought-forward row as derived and names it as not posted', async () => {
    primeSql([makeDbRow()], '2254813.96');
    const bf = (await getTrialBalance(COMPANY_ID, PERIOD_ID))
      .find(r => r.accountCode === BROUGHT_FORWARD_CODE)!;

    expect(bf.derived).toBe(true);
    expect(bf.accountName).toContain('derived');
    expect(bf.accountName).toContain('not posted');
    // The cut-off it was computed from is named, so the row is self-describing
    // in a CSV that carries no other context.
    expect(bf.accountName).toContain('2025-03-01');
  });

  it('leaves a posted retained earnings account carrying only its posted balance', async () => {
    primeSql(
      [
        makeDbRow({
          account_code: 'SYS11', account_name: 'Retained Income', account_type: 'equity',
          normal_balance: 'credit', closing_debit: '0', closing_credit: '1000000.00',
          period_debit: '0', period_credit: '0',
        }),
      ],
      '2254813.96',
    );

    const rows = await getTrialBalance(COMPANY_ID, PERIOD_ID);
    const posted = rows.find(r => r.accountCode === 'SYS11')!;
    expect(posted.creditBalance).toBe(1000000);
    expect(posted.derived).toBeUndefined();
    expect(rows.find(r => r.accountCode === BROUGHT_FORWARD_CODE)!.creditBalance).toBe(2254813.96);
  });

  it('marks every posted row as not derived', async () => {
    primeSql([makeDbRow(), makeDbRow({ account_code: '2001' })], '100');
    const rows = await getTrialBalance(COMPANY_ID, PERIOD_ID);
    const posted = rows.filter(r => r.accountCode !== BROUGHT_FORWARD_CODE);
    expect(posted).toHaveLength(2);
    expect(posted.every(r => !r.derived)).toBe(true);
  });

  it('balances: total debits equal total credits (Brightsphere Feb 2026 shape)', async () => {
    primeSql(
      [
        makeDbRow({ closing_debit: '30640532.90', closing_credit: '24637060.26', period_debit: '0', period_credit: '0' }),
        makeDbRow({
          account_code: '2001', account_type: 'liability', normal_balance: 'credit',
          closing_debit: '0', closing_credit: '3748658.68', period_debit: '0', period_credit: '0',
        }),
      ],
      '2254813.96',
    );

    const rows = await getTrialBalance(COMPANY_ID, PERIOD_ID);
    const totalDebit = round2(rows.reduce((s, r) => s + r.debitBalance, 0));
    const totalCredit = round2(rows.reduce((s, r) => s + r.creditBalance, 0));
    expect(totalDebit).toBe(6003472.64);
    expect(totalCredit).toBe(6003472.64);
    expect(totalDebit).toBe(totalCredit);
  });

  it('skips the brought-forward row entirely when nothing was earned before the year', async () => {
    primeSql([makeDbRow()], '0');
    const rows = await getTrialBalance(COMPANY_ID, PERIOD_ID);
    expect(rows.some(r => r.accountCode === BROUGHT_FORWARD_CODE)).toBe(false);
  });
});

describe('broughtForwardLine', () => {
  it('names the cut-off date and says the figure is not posted', () => {
    const line = broughtForwardLine('2025-03-01');
    expect(line.accountCode).toBe('RE-BF');
    expect(line.accountName).toContain('derived');
    expect(line.accountName).toContain('not posted');
    expect(line.accountName).toContain('2025-03-01');
  });

  it('uses a code that cannot collide with a real chart account', () => {
    // Real charts here use numeric codes or a SYS<n> prefix.
    expect(BROUGHT_FORWARD_CODE).toBe('RE-BF');
    expect(Number.isNaN(Number(BROUGHT_FORWARD_CODE))).toBe(true);
  });
});

describe('getTrialBalance (cost centre)', () => {
  it('passes the cost centre through to both the balance and brought-forward queries', async () => {
    const ccId = 'dddddddd-0000-0000-0000-000000000004';
    const mockSql = primeSql([makeDbRow()], '100.00');
    await getTrialBalance(COMPANY_ID, PERIOD_ID, ccId);
    expect(paramsOf(mockSql, 1)).toContain(ccId);
    expect(paramsOf(mockSql, 2)).toContain(ccId);
  });

  it('passes null, not undefined, when no cost centre is selected', async () => {
    const mockSql = primeSql([makeDbRow()]);
    await getTrialBalance(COMPANY_ID, PERIOD_ID);
    expect(paramsOf(mockSql, 1)).toContain(null);
  });
});

describe('getTrialBalanceReport (one balanced assertion, computed once)', () => {
  it('returns totals, difference and a balanced flag alongside the rows', async () => {
    primeSql([
      makeDbRow({ closing_debit: '30640532.90', closing_credit: '24637060.26', period_debit: '0', period_credit: '0' }),
      makeDbRow({
        account_code: '2001', account_type: 'liability', normal_balance: 'credit',
        closing_debit: '0', closing_credit: '6003472.64', period_debit: '0', period_credit: '0',
      }),
    ]);

    const report = await getTrialBalanceReport(COMPANY_ID, PERIOD_ID);
    expect(report.totalDebit).toBe(6003472.64);
    expect(report.totalCredit).toBe(6003472.64);
    expect(report.difference).toBe(0);
    expect(report.balanced).toBe(true);
    expect(report.accountCount).toBe(2);
    expect(report.rows).toHaveLength(2);
  });

  /**
   * The audit found the UI stamping "Difference R0.00 · Balanced" over a trial
   * balance showing 7 of 118 accounts. `accountCount` states the scope the
   * assertion covers, so a caller can never present it as more than it is.
   */
  it('reports the account count the assertion covers', async () => {
    primeSql([makeDbRow(), makeDbRow({ account_code: '2001' }), makeDbRow({ account_code: '3001' })]);
    const report = await getTrialBalanceReport(COMPANY_ID, PERIOD_ID);
    expect(report.accountCount).toBe(report.rows.length);
    expect(report.accountCount).toBe(3);
  });

  it('reports an out-of-balance ledger as a VALUE, not only a log line', async () => {
    primeSql([makeDbRow({ closing_debit: '1000.00', closing_credit: '0' })]);
    const report = await getTrialBalanceReport(COMPANY_ID, PERIOD_ID);
    expect(report.balanced).toBe(false);
    expect(report.difference).toBe(1000);
  });

  /**
   * 0.1 + 0.2 !== 0.3 in IEEE754. Summing a few hundred cent-values leaves
   * drift of that order, and `totalDebit === totalCredit` called it a broken
   * ledger — which is exactly what the dashboard tab did.
   */
  it('does not call sub-cent float noise an out-of-balance ledger', async () => {
    primeSql([
      makeDbRow({ closing_debit: '0.1', closing_credit: '0', period_debit: '0', period_credit: '0' }),
      makeDbRow({ account_code: '1002', closing_debit: '0.2', closing_credit: '0', period_debit: '0', period_credit: '0' }),
      makeDbRow({
        account_code: '2001', normal_balance: 'credit',
        closing_debit: '0', closing_credit: '0.3', period_debit: '0', period_credit: '0',
      }),
    ]);
    const report = await getTrialBalanceReport(COMPANY_ID, PERIOD_ID);
    // The raw sums genuinely differ...
    expect(0.1 + 0.2 === 0.3).toBe(false);
    // ...but by far less than a cent, so the ledger is balanced.
    expect(Math.abs(report.difference)).toBeLessThan(BALANCE_TOLERANCE);
    expect(report.balanced).toBe(true);
    expect(report.difference).toBe(0);
  });

  it('calls a real one-cent break out of balance', async () => {
    primeSql([
      makeDbRow({ closing_debit: '1000.01', closing_credit: '0', period_debit: '0', period_credit: '0' }),
      makeDbRow({
        account_code: '2001', normal_balance: 'credit',
        closing_debit: '0', closing_credit: '1000.00', period_debit: '0', period_credit: '0',
      }),
    ]);
    const report = await getTrialBalanceReport(COMPANY_ID, PERIOD_ID);
    expect(report.balanced).toBe(false);
    expect(report.difference).toBe(0.01);
  });

  it('carries the measurement basis so a consumer can label the report', async () => {
    primeSql([makeDbRow()]);
    const report = await getTrialBalanceReport(COMPANY_ID, PERIOD_ID);
    expect(report.periodStart).toBe('2026-02-01');
    expect(report.periodEnd).toBe('2026-02-28');
    expect(report.fiscalYearStart).toBe('2025-03-01');
    expect(report.asAtDate).toBe(report.periodEnd);
  });

  it('loads the fiscal period once, not once per entry point', async () => {
    const mockSql = primeSql([makeDbRow()]);
    await getTrialBalanceReport(COMPANY_ID, PERIOD_ID);
    // period metadata, balances, brought-forward — three queries, no repeat.
    expect(mockSql.mock.calls).toHaveLength(3);
  });

  it('returns an empty balanced report when the period is not the company own', async () => {
    (sql as SqlMock).mockResolvedValueOnce([]);
    const report = await getTrialBalanceReport(COMPANY_ID, PERIOD_ID);
    expect(report.rows).toEqual([]);
    expect(report.accountCount).toBe(0);
    expect(report.balanced).toBe(true);
    expect(report.difference).toBe(0);
  });

  it('passes the cost centre through', async () => {
    const ccId = 'dddddddd-0000-0000-0000-000000000004';
    const mockSql = primeSql([makeDbRow()]);
    const report = await getTrialBalanceReport(COMPANY_ID, PERIOD_ID, { costCentreId: ccId });
    expect(paramsOf(mockSql, 1)).toContain(ccId);
    expect(report.costCentreId).toBe(ccId);
  });
});

describe('zero balances vs no movement (the old HAVING conflated them)', () => {
  const dormant = makeDbRow({
    account_code: '1121', account_name: 'Loan Account - Blitz Fibre',
    closing_debit: '335000.00', closing_credit: '205000.00', period_debit: '0', period_credit: '0',
  });
  const nettedToZero = makeDbRow({
    account_code: '49512173', account_name: 'Loan account - Integrivest',
    closing_debit: '25000.00', closing_credit: '25000.00', period_debit: '0', period_credit: '0',
  });

  it('always returns an account that carries a balance but did not move', async () => {
    primeSql([dormant]);
    const rows = await getTrialBalance(COMPANY_ID, PERIOD_ID);
    expect(rows).toHaveLength(1);
    // "no movement this period" is answerable: a balance with both movement columns at zero.
    expect(rows[0]!.debitBalance).toBe(130000);
    expect(rows[0]!.periodDebit).toBe(0);
    expect(rows[0]!.periodCredit).toBe(0);
  });

  it('drops a genuinely zero account by default', async () => {
    primeSql([dormant, nettedToZero]);
    const rows = await getTrialBalance(COMPANY_ID, PERIOD_ID);
    expect(rows.map(r => r.accountCode)).toEqual(['1121']);
  });

  it('includeZeroBalances keeps it, so "nothing to show" is distinguishable', async () => {
    primeSql([dormant, nettedToZero]);
    const rows = await getTrialBalance(COMPANY_ID, PERIOD_ID, undefined, { includeZeroBalances: true });
    expect(rows.map(r => r.accountCode)).toEqual(['1121', '49512173']);
    const zero = rows[1]!;
    expect(zero.debitBalance).toBe(0);
    expect(zero.creditBalance).toBe(0);
    expect(zero.periodDebit).toBe(0);
  });

  it('includeZeroBalances does not change whether the report balances', async () => {
    primeSql([dormant, nettedToZero]);
    const report = await getTrialBalanceReport(COMPANY_ID, PERIOD_ID, { includeZeroBalances: true });
    expect(report.accountCount).toBe(2);
    expect(report.totalDebit).toBe(130000);
    expect(report.totalCredit).toBe(0);
    expect(report.balanced).toBe(false);
  });
});
