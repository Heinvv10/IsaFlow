/**
 * Unit tests for generalLedgerReportService.
 *
 * Regression guard for issue #287: the GL report page queried only
 * `accounts.slice(0, 20)` while claiming "All account transactions for period".
 * On production that rendered "No account activity for the selected period" for
 * Brightsphere 2022-11, a month holding 419 posted lines across 29 accounts —
 * every account with movement sorted past position 20.
 *
 * The cap is what these tests exist to prevent coming back, so the account-count
 * test deliberately seeds MORE than 20 accounts with activity.
 *
 * All DB calls are mocked — no live connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn() };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getGeneralLedgerReport } from '@/modules/accounting/services/gl/generalLedgerReportService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

/** Queue the three result sets the service reads, in call order. */
function seed(accounts: Row[], openings: Row[], txns: Row[]) {
  mockSql
    .mockResolvedValueOnce(accounts)
    .mockResolvedValueOnce(openings)
    .mockResolvedValueOnce(txns);
}

function account(code: string, normal = 'debit'): Row {
  return {
    account_code: code,
    account_name: `Account ${code}`,
    account_type: normal === 'debit' ? 'expense' : 'liability',
    normal_balance: normal,
  };
}

function line(code: string, debit: number, credit: number, date = '2022-11-20'): Row {
  return {
    account_code: code,
    entry_date: date,
    entry_number: `JE-${code}`,
    description: `line ${code}`,
    source: 'auto_bank_recon',
    debit,
    credit,
  };
}

beforeEach(() => {
  mockSql.mockReset();
});

describe('getGeneralLedgerReport', () => {
  it('returns EVERY account with activity, not just the first 20', async () => {
    // 29 accounts with movement — the exact shape that broke on production.
    const codes = Array.from({ length: 29 }, (_, i) => String(30000 + i));
    seed(
      codes.map(c => account(c)),
      [],
      codes.map(c => line(c, 100, 0))
    );

    const report = await getGeneralLedgerReport(COMPANY, '2022-11-01', '2022-11-30');

    expect(report).toHaveLength(29);
    // The accounts that used to be dropped are the ones sorted last.
    expect(report.map(r => r.accountCode)).toContain('30028');
  });

  it('issues a constant number of queries regardless of account count', async () => {
    const codes = Array.from({ length: 120 }, (_, i) => String(40000 + i));
    seed(codes.map(c => account(c)), [], codes.map(c => line(c, 5, 0)));

    await getGeneralLedgerReport(COMPANY, '2022-11-01', '2022-11-30');

    // Three: accounts, opening balances, in-period lines. Never one per account.
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('scopes every query to the requesting company', async () => {
    seed([account('5000')], [], [line('5000', 10, 0)]);

    await getGeneralLedgerReport(COMPANY, '2022-11-01', '2022-11-30');

    for (const call of mockSql.mock.calls) {
      expect(call.flat().some(v => v === COMPANY)).toBe(true);
    }
  });

  it('accumulates a running balance per account independently', async () => {
    seed(
      [account('5000'), account('6000')],
      [],
      [
        line('5000', 100, 0, '2022-11-01'),
        line('5000', 50, 0, '2022-11-02'),
        line('6000', 7, 0, '2022-11-01'),
      ]
    );

    const report = await getGeneralLedgerReport(COMPANY, '2022-11-01', '2022-11-30');
    const a = report.find(r => r.accountCode === '5000')!;
    const b = report.find(r => r.accountCode === '6000')!;

    expect(a.transactions.map(t => t.balance)).toEqual([100, 150]);
    expect(a.closingBalance).toBe(150);
    expect(a.totalDebit).toBe(150);
    // 6000's running balance must not inherit 5000's.
    expect(b.transactions.map(t => t.balance)).toEqual([7]);
  });

  it('applies opening balances in the account\'s normal direction', async () => {
    seed(
      [account('5000', 'debit'), account('2000', 'credit')],
      [
        { account_code: '5000', total_debit: 300, total_credit: 100 },
        { account_code: '2000', total_debit: 100, total_credit: 400 },
      ],
      [line('5000', 0, 50), line('2000', 0, 25)]
    );

    const report = await getGeneralLedgerReport(COMPANY, '2022-11-01', '2022-11-30');
    const debitAcct = report.find(r => r.accountCode === '5000')!;
    const creditAcct = report.find(r => r.accountCode === '2000')!;

    expect(debitAcct.openingBalance).toBe(200); // 300 Dr - 100 Cr
    expect(debitAcct.closingBalance).toBe(150); // less a 50 credit
    expect(creditAcct.openingBalance).toBe(300); // 400 Cr - 100 Dr
    expect(creditAcct.closingBalance).toBe(325); // plus a 25 credit
  });

  it('includes an account with an opening balance but no movement', async () => {
    seed(
      [account('1120')],
      [{ account_code: '1120', total_debit: 1000, total_credit: 0 }],
      []
    );

    const report = await getGeneralLedgerReport(COMPANY, '2022-11-01', '2022-11-30');

    expect(report).toHaveLength(1);
    expect(report[0]!.openingBalance).toBe(1000);
    expect(report[0]!.transactions).toEqual([]);
  });

  it('omits accounts with neither movement nor an opening balance', async () => {
    seed([account('5000'), account('9999')], [], [line('5000', 10, 0)]);

    const report = await getGeneralLedgerReport(COMPANY, '2022-11-01', '2022-11-30');

    expect(report.map(r => r.accountCode)).toEqual(['5000']);
  });

  it('returns empty rather than throwing when the company has no accounts', async () => {
    mockSql.mockResolvedValueOnce([]);

    await expect(getGeneralLedgerReport(COMPANY, '2022-11-01', '2022-11-30')).resolves.toEqual([]);
  });
});
