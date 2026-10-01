/**
 * getAccountLedger with an INCOME-STATEMENT account, SQL mocked (LED-01 / W2-04).
 *
 * accountLedgerService.test.ts only ever feeds asset/liability accounts, so the
 * fiscal-year floor and the year-end close row were invisible to it. This pins
 * them at the SQL-argument level: which floor date the opening query binds, that
 * a balance-sheet account binds none, the March fallback, and the close row's
 * placement. (Separate file: accountLedgerService.test.ts is already 592 lines.)
 * The Postgres-backed behaviour is in accountLedgerFiscalYearDb.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn() };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCOUNT = 'cccccccc-1111-0000-0000-000000000001';
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

function meta(accountType: string, normal: string, fyStart: number | null) {
  return [{ id: ACCOUNT, account_code: '5200', account_name: 'Labour', account_type: accountType,
    normal_balance: normal, financial_year_start: fyStart }];
}
const txn = (date: string, debit: number) => ({ journal_entry_id: `je-${date}`, entry_date: date,
  entry_number: date, description: '', reference: '', source: 'manual', debit: String(debit), credit: '0' });

/** Interpolated values of the n-th sql call. */
const args = (n: number) => sqlMock.mock.calls[n]?.slice(1) ?? [];

async function readSeptember(accountType: string, normal: string, fyStart: number | null) {
  sqlMock
    .mockResolvedValueOnce(meta(accountType, normal, fyStart))
    .mockResolvedValueOnce([{ total_debit: '0', total_credit: '0' }])
    .mockResolvedValueOnce([{ total: '0' }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ period_debit: '0', period_credit: '0' }]);
  return getAccountLedger({ companyId: COMPANY, accountId: ACCOUNT, fromDate: '2025-09-01', toDate: '2025-09-30' });
}

beforeEach(() => { sqlMock.mockReset(); });

describe('getAccountLedger — income-statement account (mocked SQL)', () => {
  it('floors an expense account opening at the company FY start (July)', async () => {
    await readSeptember('expense', 'debit', 7);
    expect(args(1)).toContain('2025-07-01');
    expect(sqlMock).toHaveBeenCalledTimes(5); // no year-end close query inside one fiscal year
  });

  it('falls back to March when financial_year_start is NULL', async () => {
    await readSeptember('revenue', 'credit', null);
    expect(args(1)).toContain('2025-03-01');
  });

  it('binds no floor for a balance-sheet account', async () => {
    await readSeptember('asset', 'debit', 7);
    expect(args(1)).not.toContain('2025-07-01');
    expect(args(1)).toContain(null);
  });

  it('places a derived close row at the FY end and resets the running balance', async () => {
    sqlMock
      .mockResolvedValueOnce(meta('expense', 'debit', 7))
      .mockResolvedValueOnce([{ total_debit: '0', total_credit: '0' }])  // opening (floor 2024-07-01)
      .mockResolvedValueOnce([{ total: '2' }])                           // line count
      .mockResolvedValueOnce([{ bucket: 0, d: '300', c: '0', n: '1' }]) // grouped: the year closing 2025-07-01
      .mockResolvedValueOnce([txn('2025-06-15', 300), txn('2025-08-01', 50)])
      .mockResolvedValueOnce([{ period_debit: '350', period_credit: '0' }]);

    const r = await getAccountLedger({ companyId: COMPANY, accountId: ACCOUNT, fromDate: '2025-06-01', toDate: '2025-09-30' });

    expect(args(3)).toContain('2025-07-01');
    expect(r.rows.map(x => [x.entryDate, x.debit, x.credit, x.runningBalance, x.derived ?? false])).toEqual([
      ['2025-06-15', 300, 0, 300, false],
      ['2025-06-30', 0, 300, 0, true],
      ['2025-08-01', 50, 0, 50, false],
    ]);
    expect(r).toMatchObject({ total: 3, derivedRows: 1, periodNet: 350, closedToRetainedEarnings: -300, periodClosingBalance: 50 });
  });
});
