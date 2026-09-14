import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getIncomeStatement, sql } = vi.hoisted(() => ({
  getIncomeStatement: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/modules/accounting/services/reports/financialReportingService', () => ({ getIncomeStatement }));
vi.mock('@/lib/neon', () => ({ sql }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (handler: unknown) => handler,
  withWriteAccess: (handler: unknown) => handler,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (handler: unknown) => handler }));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 0 }));

import reportHandler from '../../../pages/api/accounting/reports-income-statement';
import csvHandler from '../../../pages/api/accounting/income-statement-export';
import xlsxHandler from '../../../pages/api/accounting/income-statement-xlsx';

const companyId = '10000000-0000-4000-8000-000000000001';
const businessUnitId = '20000000-0000-4000-8000-000000000001';
const costCentreId = '30000000-0000-4000-8000-000000000001';

const emptyReport = {
  periodStart: '2026-04-01', periodEnd: '2026-04-30',
  revenue: [], otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 0, totalOtherIncome: 0, totalCostOfSales: 0,
  totalOperatingExpenses: 0, totalOtherExpenses: 0,
  grossProfit: 0, operatingProfit: 0, netProfit: 0,
};

function response() {
  const chunks: Buffer[] = [];
  return Object.assign(new Writable({
    write(chunk: Buffer, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
  }), {
    chunks,
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    setHeader: vi.fn(),
    send: vi.fn(),
  }) as unknown as NextApiResponse & { chunks: Buffer[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  getIncomeStatement.mockResolvedValue(emptyReport);
  sql.mockResolvedValue([{ name: 'Fixture' }]);
});

describe.each([
  ['report', reportHandler],
  ['CSV', csvHandler],
  ['XLSX', xlsxHandler],
] as const)('%s income statement business-unit validation', (_kind, handler) => {
  it.each(['broken', '', [businessUnitId], [businessUnitId, businessUnitId]])(
    'rejects %j before querying', async invalid => {
      const res = response();
      await handler({ method: 'GET', companyId, query: {
        period_start: '2026-04-01', period_end: '2026-04-30',
        business_unit_id: invalid,
      } } as unknown as NextApiRequest, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ message: 'business_unit_id must be a valid UUID' }),
      }));
      expect(getIncomeStatement).not.toHaveBeenCalled();
    },
  );

  it.each(['broken', [costCentreId], [costCentreId, costCentreId]])(
    'rejects malformed or repeated cost centres before querying', async invalid => {
      const res = response();
      await handler({ method: 'GET', companyId, query: {
        period_start: '2026-04-01', period_end: '2026-04-30',
        cost_centre_id: invalid,
      } } as unknown as NextApiRequest, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ message: 'cost_centre_id must be a valid UUID' }),
      }));
      expect(getIncomeStatement).not.toHaveBeenCalled();
    },
  );
});

it.each(['broken', ['40000000-0000-4000-8000-000000000001']])(
  'report rejects malformed or repeated project IDs before querying', async invalid => {
    const res = response();
    await reportHandler({ method: 'GET', companyId, query: {
      period_start: '2026-04-01', period_end: '2026-04-30', project_id: invalid,
    } } as unknown as NextApiRequest, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ message: 'project_id must be a valid UUID' }),
    }));
    expect(getIncomeStatement).not.toHaveBeenCalled();
  },
);

it.each([
  ['report', reportHandler],
  ['CSV', csvHandler],
  ['XLSX', xlsxHandler],
] as const)('%s passes both cumulative dimensions to the service', async (_kind, handler) => {
  const res = response();
  await handler({ method: 'GET', companyId, query: {
    period_start: '2026-04-01', period_end: '2026-04-30',
    cost_centre_id: costCentreId, business_unit_id: businessUnitId,
  } } as unknown as NextApiRequest, res);

  expect(getIncomeStatement).toHaveBeenCalledWith(
    companyId,
    '2026-04-01',
    '2026-04-30',
    expect.objectContaining({ costCentreId, businessUnitId }),
    ...(_kind === 'report' ? [undefined] : []),
  );
});
