import { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getBalanceSheet, sql } = vi.hoisted(() => ({
  getBalanceSheet: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/modules/accounting/services/reports/financialReportingService', () => ({ getBalanceSheet }));
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

import reportHandler from '../../../pages/api/accounting/reports-balance-sheet';
import csvHandler from '../../../pages/api/accounting/balance-sheet-export';
import xlsxHandler from '../../../pages/api/accounting/balance-sheet-xlsx';

const companyId = '10000000-0000-4000-8000-000000000001';
const businessUnitId = '20000000-0000-4000-8000-000000000001';
const costCentreId = '30000000-0000-4000-8000-000000000001';
const emptyReport = { asAtDate: '2026-04-30', assets: [], liabilities: [], equity: [],
  totalAssets: 0, totalLiabilities: 0, totalEquity: 0 };
const presentationReport = {
  asAtDate: '2026-04-30',
  assets: [{ accountCode: '1000', accountName: 'Cash', balance: 300 }],
  liabilities: [{ accountCode: '2000', accountName: 'Payables', balance: 100 }],
  equity: [{ accountCode: '3000', accountName: 'Capital', balance: 200 }],
  totalAssets: 300, totalLiabilities: 100, totalEquity: 200,
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
    end: vi.fn(),
  }) as unknown as NextApiResponse & { chunks: Buffer[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  getBalanceSheet.mockResolvedValue(emptyReport);
  sql.mockResolvedValue([{ name: 'Fixture' }]);
});

describe.each([
  ['report', reportHandler],
  ['CSV', csvHandler],
  ['XLSX', xlsxHandler],
] as const)('%s balance-sheet dimension validation', (kind, handler) => {
  it.each(['broken', '', [businessUnitId], [businessUnitId, businessUnitId]])(
    'rejects business unit %j before querying', async invalid => {
      const res = response();
      await handler({ method: 'GET', companyId, query: {
        as_at_date: '2026-04-30', business_unit_id: invalid,
      } } as unknown as NextApiRequest, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ message: 'business_unit_id must be a valid UUID' }),
      }));
      expect(getBalanceSheet).not.toHaveBeenCalled();
    },
  );

  it.each(['broken', [costCentreId], [costCentreId, costCentreId]])(
    'rejects cost centre %j before querying', async invalid => {
      const res = response();
      await handler({ method: 'GET', companyId, query: {
        as_at_date: '2026-04-30', cost_centre_id: invalid,
      } } as unknown as NextApiRequest, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ message: 'cost_centre_id must be a valid UUID' }),
      }));
      expect(getBalanceSheet).not.toHaveBeenCalled();
    },
  );

  it('passes cumulative dimensions to the service', async () => {
    const res = response();
    await handler({ method: 'GET', companyId, query: {
      as_at_date: '2026-04-30', compare_date: '2025-04-30',
      cost_centre_id: costCentreId, business_unit_id: businessUnitId,
    } } as unknown as NextApiRequest, res);

    expect(getBalanceSheet).toHaveBeenCalledWith(
      companyId, '2026-04-30', costCentreId,
      kind === 'report' ? '2025-04-30' : undefined,
      businessUnitId,
    );
  });
});

describe('balance-sheet download presentation', () => {
  it('writes Equity before Liabilities in CSV', async () => {
    getBalanceSheet.mockResolvedValueOnce(presentationReport);
    const res = response();
    await csvHandler({ method: 'GET', companyId, query: { as_at_date: '2026-04-30' } } as unknown as NextApiRequest, res);

    const csv = String(vi.mocked(res.send).mock.calls[0]?.[0]);
    expect(csv.split('\n').slice(6)).toEqual([
      '"Assets","1000","Cash",300.00',
      '"Assets","","Total Assets",300.00',
      '"Equity","3000","Capital",200.00',
      '"Equity","","Total Equity",200.00',
      '"Liabilities","2000","Payables",100.00',
      '"Liabilities","","Total Liabilities",100.00',
    ]);
  });

  it('writes Equity before Liabilities and names the combined total in XLSX', async () => {
    getBalanceSheet.mockResolvedValueOnce(presentationReport);
    const res = response();
    await xlsxHandler({ method: 'GET', companyId, query: { as_at_date: '2026-04-30' } } as unknown as NextApiRequest, res);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.concat(res.chunks) as unknown as ExcelJS.Buffer);
    const wanted = new Set([
      'Assets', 'Total Assets', 'Equity', 'Total Equity',
      'Liabilities', 'Total Liabilities', 'Total Equity and Liabilities',
    ]);
    const labels = workbook.getWorksheet('Balance Sheet')!.getColumn(1).values
      .filter((value): value is string => typeof value === 'string' && wanted.has(value));
    expect(labels).toEqual([
      'Assets', 'Assets', 'Total Assets',
      'Equity', 'Equity', 'Total Equity',
      'Liabilities', 'Liabilities', 'Total Liabilities',
      'Total Equity and Liabilities',
    ]);
  });
});
