/**
 * D4: the trial-balance CSV reconciles a period that crosses a fiscal-year start.
 * Opening + movement differs from closing on the income-statement rows and RE-BF
 * by the derived year-end close; the export lists that close per row, in debit /
 * credit, after the unchanged column layout. Inside one fiscal year the file is
 * unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getTrialBalanceReport, sqlMock } = vi.hoisted(() => ({ getTrialBalanceReport: vi.fn(), sqlMock: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/trialBalanceService', () => ({ getTrialBalanceReport }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import exportHandler from '../../../pages/api/accounting/trial-balance-export';

const companyId = '10000000-0000-4000-8000-000000000001';
const periodId = '20000000-0000-4000-8000-000000000001';

const row = (accountCode: string, accountName: string, normalBalance: 'debit' | 'credit', closedToRetainedEarnings: number, derived = false) => ({
  accountCode, accountName, accountType: derived ? 'equity' : 'expense', normalBalance, derived,
  debitBalance: 0, creditBalance: 0, openingDebit: 0, openingCredit: 0, periodDebit: 0, periodCredit: 0, closedToRetainedEarnings,
});

async function csvFor(report: Record<string, unknown>): Promise<string> {
  getTrialBalanceReport.mockResolvedValue({
    accountCount: 3, totalDebit: 0, totalCredit: 0, difference: 0, balanced: true, fiscalYearStart: '2026-03-01', ...report,
  });
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), send: vi.fn() };
  await exportHandler({ method: 'GET', companyId, query: { fiscal_period_id: periodId } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse);
  expect(res.status).toHaveBeenCalledWith(200);
  return String(res.send.mock.calls[0]![0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValueOnce([{ name: 'Co' }])
    .mockResolvedValueOnce([{ name: 'FY26', start_date: '2026-01-01', end_date: '2026-12-31' }]);
});

describe('trial-balance CSV — derived year-end close', () => {
  it('lists each row the close moved, in debit/credit, after the unchanged columns', async () => {
    const csv = await csvFor({
      fiscalYearEndsClosed: ['2026-02-28'],
      rows: [row('1100', 'Bank', 'debit', 0), row('4300', 'Income', 'credit', -100), row('5200', 'Labour', 'debit', -1300),
        row('RE-BF', 'Retained Earnings b/f', 'credit', -1200, true)],
    });
    const lines = csv.split('\n');
    const at = lines.indexOf('Account Code,Account Name,Closed Debit,Closed Credit');
    expect(lines[at - 1]).toContain('Fiscal year end 2026-02-28');
    expect(lines.slice(at + 1)).toEqual([
      '"4300","Income",100.00,0.00',
      '"5200","Labour",0.00,1300.00',
      '"RE-BF","Retained Earnings b/f",1200.00,0.00',
    ]);
  });

  it('adds nothing inside one fiscal year', async () => {
    const csv = await csvFor({ fiscalYearEndsClosed: [], rows: [row('5200', 'Labour', 'debit', 0)] });
    expect(csv).not.toContain('Year-end close');
    expect(csv.split('\n').at(-1)).toContain('Income statement measured from');
  });
});
