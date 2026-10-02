/**
 * D4 (R1 on PR #595), without a database: the trial balance takes the
 * income-statement cut-off from the fiscal year containing the period END, and
 * the opening from the fiscal year containing the period START. Behaviour
 * against real Postgres: ledgerFiscalYearAgreementDb, trialBalanceFiscalYearFootingDb.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { getTrialBalance, getTrialBalanceReport } from '@/modules/accounting/services/gl/trialBalanceService';

type SqlMock = ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as SqlMock;
const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';

const row = (o: Record<string, unknown>) => ({
  account_code: '5200', account_name: 'Labour', account_type: 'expense', normal_balance: 'debit',
  closing_debit: '0', closing_credit: '0', opening_net: '0', period_debit: '0', period_credit: '0', ...o,
});

const params = (call: number) => (mockSql.mock.calls[call] as unknown[]).slice(1);

beforeEach(() => { mockSql.mockReset(); });

describe('trial balance across a fiscal-year start (Jan–Dec period, March FY)', () => {
  it('cuts income-statement closings at the FY of the period end, openings at the FY of the period start', async () => {
    mockSql
      .mockResolvedValueOnce([{ start_date: '2026-01-01', end_date: '2026-12-31', fy_start_month: 3 }])
      .mockResolvedValueOnce([row({ closing_debit: '250', opening_net: '1000', period_debit: '550' })])
      .mockResolvedValueOnce([{ retained: '-1207' }])
      .mockResolvedValueOnce([{ retained: '-7' }]);

    const report = await getTrialBalanceReport(COMPANY, 'period');

    expect(report.fiscalYearStart).toBe('2026-03-01');
    expect(report.fiscalYearEndsClosed).toEqual(['2026-02-28']);
    expect(params(1)).toEqual(expect.arrayContaining(['2026-03-01', '2025-03-01', '2026-01-01', '2026-12-31']));
    // Brought-forward profit: closing as at the FY of the end, opening as at the FY of the start.
    expect(params(2)).toContain('2026-03-01');
    expect(params(3)).toContain('2025-03-01');
    const bf = report.rows.find(r => r.accountCode === 'RE-BF')!;
    expect([bf.debitBalance, bf.creditBalance, bf.openingDebit, bf.openingCredit]).toEqual([1207, 0, 7, 0]);
    expect(bf.accountName).toContain('profit before 2026-03-01');
    const labour = report.rows.find(r => r.accountCode === '5200')!;
    expect([labour.openingDebit, labour.periodDebit, labour.debitBalance]).toEqual([1000, 550, 250]);
    // The derived close, on each account's normal side: opening + movement + close = closing.
    expect([labour.closedToRetainedEarnings, bf.closedToRetainedEarnings]).toEqual([-1300, -1200]);
  });

  it('asks for the brought-forward profit once when the period sits inside one fiscal year', async () => {
    mockSql
      .mockResolvedValueOnce([{ start_date: '2026-04-01', end_date: '2026-04-30', fy_start_month: 3 }])
      .mockResolvedValueOnce([row({ closing_debit: '200', period_debit: '200' })])
      .mockResolvedValueOnce([{ retained: '-1207' }]);

    const report = await getTrialBalanceReport(COMPANY, 'period');
    const rows = report.rows;

    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(report.fiscalYearEndsClosed).toEqual([]);
    expect(rows.map(r => r.closedToRetainedEarnings)).toEqual([0, 0]);
    const bf = rows.find(r => r.accountCode === 'RE-BF')!;
    expect([bf.creditBalance, bf.openingCredit, bf.debitBalance, bf.openingDebit]).toEqual([0, 0, 1207, 1207]);
  });

  it('keeps an account that only opens with a balance, so the opening column foots', async () => {
    mockSql
      .mockResolvedValueOnce([{ start_date: '2026-01-01', end_date: '2026-03-31', fy_start_month: 3 }])
      .mockResolvedValueOnce([row({ opening_net: '1300' })])
      .mockResolvedValueOnce([{ retained: '0' }])
      .mockResolvedValueOnce([{ retained: '0' }]);

    const rows = await getTrialBalance(COMPANY, 'period');

    expect(rows.map(r => [r.accountCode, r.openingDebit, r.debitBalance])).toEqual([['5200', 1300, 0]]);
  });
});
