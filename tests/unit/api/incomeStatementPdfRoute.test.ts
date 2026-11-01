/**
 * income-statement-pdf: the same query contract as the xlsx route, plus the
 * report rate limit a PDF render earns. Everything refused is refused before a
 * figure is read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getIncomeStatement, checkReportRateLimit, getCompanyDetailsFromCompany, sql } = vi.hoisted(() => ({
  getIncomeStatement: vi.fn(),
  checkReportRateLimit: vi.fn(),
  getCompanyDetailsFromCompany: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/modules/accounting/services/reports/financialReportingService', () => ({ getIncomeStatement }));
vi.mock('@/modules/accounting/services/core/pdfShared', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/core/pdfShared')>()), getCompanyDetailsFromCompany,
}));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit }));
vi.mock('@/lib/neon', () => ({ sql, withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/income-statement-pdf';

const companyId = '10000000-0000-4000-8000-000000000001';
const cc = '20000000-0000-4000-8000-000000000002';
const bu = '30000000-0000-4000-8000-000000000003';
const report = {
  periodStart: '2026-04-01', periodEnd: '2026-04-30',
  revenue: [], otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 0, totalOtherIncome: 0, totalCostOfSales: 0, totalOperatingExpenses: 0, totalOtherExpenses: 0,
  grossProfit: 0, operatingProfit: 0, netProfit: 0,
};

async function call(query: Record<string, unknown>, method = 'GET') {
  const headers: Record<string, unknown> = {};
  const out: { status: number; body: unknown; headers: Record<string, unknown> } = { status: 200, body: undefined, headers };
  const res = {
    setHeader: (k: string, v: unknown) => { headers[k] = v; return res; },
    status: (c: number) => { out.status = c; return res; },
    json: (b: unknown) => { out.body = b; return res; },
    send: (b: unknown) => { out.body = b; return res; },
    end: (b: unknown) => { out.body = b; return res; },
  } as unknown as NextApiResponse;
  const req = { method, companyId, query } as unknown as NextApiRequest;
  await (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, res);
  return out;
}

const PERIOD = { period_start: '2026-04-01', period_end: '2026-04-30' };

beforeEach(() => {
  vi.clearAllMocks();
  getIncomeStatement.mockResolvedValue(report);
  checkReportRateLimit.mockResolvedValue(true);
  getCompanyDetailsFromCompany.mockResolvedValue({ name: 'Fixture', primaryColor: '#0f766e' });
  sql.mockResolvedValue([{ code: 'X', name: 'Y' }]);
});

describe('income-statement-pdf', () => {
  it('refuses anything but GET', async () => {
    expect((await call(PERIOD, 'POST')).status).toBe(405);
  });

  it('returns a PDF download for the period', async () => {
    const out = await call(PERIOD);
    expect(out.status).toBe(200);
    expect(out.headers['Content-Type']).toBe('application/pdf');
    expect(out.headers['Content-Disposition']).toBe('attachment; filename="income-statement-2026-04-01-to-2026-04-30.pdf"');
    expect(out.headers['Cache-Control']).toBe('private, no-store');
    expect((out.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('reads the signed-in company, with the filters, and charges its rate limit', async () => {
    await call({ ...PERIOD, cost_centre_id: cc, business_unit_id: bu });
    expect(checkReportRateLimit).toHaveBeenCalledWith(companyId, 'income-statement-pdf');
    expect(getIncomeStatement).toHaveBeenCalledWith(companyId, '2026-04-01', '2026-04-30', { costCentreId: cc, businessUnitId: bu });
  });

  it('answers 429 over the limit, before reading a figure', async () => {
    checkReportRateLimit.mockResolvedValue(false);
    expect((await call(PERIOD)).status).toBe(429);
    expect(getIncomeStatement).not.toHaveBeenCalled();
  });

  it.each([
    ['no dates', {}],
    ['no end', { period_start: '2026-04-01' }],
    ['a date that does not exist', { ...PERIOD, period_end: '2026-02-31' }],
    ['a date with a header in it', { ...PERIOD, period_start: '2026-04-01"\r\nX: y' }],
    ['a repeated date', { ...PERIOD, period_start: ['2026-04-01', '2026-04-02'] }],
    ['an inverted range', { period_start: '2026-05-01', period_end: '2026-04-30' }],
    ['a bad cost centre', { ...PERIOD, cost_centre_id: 'nope' }],
    ['a bad business unit', { ...PERIOD, business_unit_id: 'nope' }],
    ['a bad group_by', { ...PERIOD, group_by: 'project' }],
  ])('refuses %s without charging the limit or reading a figure', async (_name, query) => {
    expect((await call(query)).status).toBe(400);
    expect(checkReportRateLimit).not.toHaveBeenCalled();
    expect(getIncomeStatement).not.toHaveBeenCalled();
  });

  it.each(['cc1', 'cc2', 'bu'])('sends group_by=%s to Excel', async (group_by) => {
    const out = await call({ ...PERIOD, group_by });
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).toContain('Group-by is exported to Excel only');
    expect(getIncomeStatement).not.toHaveBeenCalled();
  });
});
