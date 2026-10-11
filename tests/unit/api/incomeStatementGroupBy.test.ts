/**
 * group_by on the income-statement report and xlsx routes: the statement is
 * computed ONCE (the matrix carries the ungrouped report it ties to), and a
 * comparative asked for alongside group_by is refused, not silently dropped.
 */
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getIncomeStatement, getIncomeStatementByDimension, sql } = vi.hoisted(() => ({
  getIncomeStatement: vi.fn(),
  getIncomeStatementByDimension: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/modules/accounting/services/reports/financialReportingService', () => ({
  getIncomeStatement, getIncomeStatementByDimension,
}));
vi.mock('@/lib/neon', () => ({ sql }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h }));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 0 }));

import reportHandler from '../../../pages/api/accounting/reports-income-statement';
import xlsxHandler from '../../../pages/api/accounting/income-statement-xlsx';

const companyId = '10000000-0000-4000-8000-000000000001';
const report = {
  periodStart: '2026-04-01', periodEnd: '2026-04-30',
  revenue: [], otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 0, totalOtherIncome: 0, totalCostOfSales: 0, totalOperatingExpenses: 0, totalOtherExpenses: 0,
  grossProfit: 0, operatingProfit: 0, netProfit: 0,
};
const zero = { turnover: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0, operatingExpenses: 0,
  depreciation: 0, operatingProfit: 0, otherExpenses: 0, netProfit: 0 };
const matrix = {
  periodStart: '2026-04-01', periodEnd: '2026-04-30', groupBy: 'bu',
  members: [], lines: [], columns: [], report, residual: zero,
};

function response() {
  return Object.assign(new Writable({ write(_c, _e, done) { done(); } }), {
    status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), send: vi.fn(),
  }) as unknown as NextApiResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}
const req = (query: Record<string, string>) =>
  ({ method: 'GET', companyId, query: { period_start: '2026-04-01', period_end: '2026-04-30', ...query } }) as unknown as NextApiRequest;

beforeEach(() => {
  vi.clearAllMocks();
  getIncomeStatement.mockResolvedValue(report);
  getIncomeStatementByDimension.mockResolvedValue(matrix);
  sql.mockResolvedValue([{ name: 'Fixture' }]);
});

describe('reports-income-statement group_by', () => {
  it('computes the statement once and returns it with byDimension', async () => {
    const res = response();
    await reportHandler(req({ group_by: 'bu' }), res);
    expect(getIncomeStatementByDimension).toHaveBeenCalledTimes(1);
    expect(getIncomeStatement).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ netProfit: 0, byDimension: { groupBy: 'bu', residual: zero } });
  });

  it.each([{ compare_start: '2026-03-01', compare_end: '2026-03-31' }, { compare_start: '2026-03-01' }])(
    'refuses %j with group_by instead of dropping the comparative', async (compare) => {
      const res = response();
      await reportHandler(req({ group_by: 'cc1', ...compare }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ message: 'compare_start / compare_end cannot be combined with group_by' }),
      }));
      expect(getIncomeStatementByDimension).not.toHaveBeenCalled();
      expect(getIncomeStatement).not.toHaveBeenCalled();
    },
  );
});

describe('income-statement-xlsx group_by', () => {
  it('builds both sheets from one computation', async () => {
    await xlsxHandler(req({ group_by: 'bu' }) as never, response());
    expect(getIncomeStatementByDimension).toHaveBeenCalledTimes(1);
    expect(getIncomeStatement).not.toHaveBeenCalled();
  });
});
