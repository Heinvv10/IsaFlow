/**
 * reports-income-statement: a malformed or backwards date is a 400 that names
 * the parameter (no stack), checked before any service call; a valid range is
 * unchanged.
 */
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getIncomeStatement, getIncomeStatementByDimension } = vi.hoisted(() => ({
  getIncomeStatement: vi.fn(),
  getIncomeStatementByDimension: vi.fn(),
}));

vi.mock('@/modules/accounting/services/reports/financialReportingService', () => ({
  getIncomeStatement, getIncomeStatementByDimension,
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h }));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 0 }));

import reportHandler from '../../../pages/api/accounting/reports-income-statement';

const companyId = '10000000-0000-4000-8000-000000000001';
const report = { periodStart: '2026-04-01', periodEnd: '2026-04-30', netProfit: 0 };

function response() {
  return Object.assign(new Writable({ write(_c, _e, done) { done(); } }), {
    status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), send: vi.fn(),
  }) as unknown as NextApiResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}
const req = (query: Record<string, string | string[]>) =>
  ({ method: 'GET', companyId, query: { period_start: '2026-04-01', period_end: '2026-04-30', ...query } }) as unknown as NextApiRequest;

beforeEach(() => {
  vi.clearAllMocks();
  getIncomeStatement.mockResolvedValue(report);
});

describe('reports-income-statement date parameters', () => {
  it.each([
    ['start=abc', { period_start: 'abc' }, 'period_start must be a YYYY-MM-DD date'],
    ['start blank', { period_start: '' }, 'period_start'],
    ['start 2026-8-1', { period_start: '2026-8-1' }, 'period_start must be a YYYY-MM-DD date'],
    ['start 2026-13-01', { period_start: '2026-13-01' }, 'period_start must be a YYYY-MM-DD date'],
    ['start 2026-02-31', { period_start: '2026-02-31' }, 'period_start must be a YYYY-MM-DD date'],
    ['start repeated', { period_start: ['2026-04-01', '2026-04-02'] }, 'period_start must be a YYYY-MM-DD date'],
    ['end=abc', { period_end: 'abc' }, 'period_end must be a YYYY-MM-DD date'],
    ['end blank', { period_end: '' }, 'period_end'],
    ['end 2026-04-31', { period_end: '2026-04-31' }, 'period_end must be a YYYY-MM-DD date'],
    ['end before start', { period_end: '2026-03-31' }, 'period_start must not be after period_end'],
    ['compare_start=abc', { compare_start: 'abc', compare_end: '2026-03-31' }, 'compare_start must be a YYYY-MM-DD date'],
    ['compare_end 2026-13-01', { compare_start: '2026-03-01', compare_end: '2026-13-01' }, 'compare_end must be a YYYY-MM-DD date'],
    ['compare end before start', { compare_start: '2026-03-31', compare_end: '2026-03-01' }, 'compare_start must not be after compare_end'],
  ])('%s -> 400 naming the parameter, no stack', async (_name, query, message) => {
    const res = response();
    await reportHandler(req(query), res);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0]![0] as { error: { message: string } };
    expect(body.error.message).toContain(message);
    expect(JSON.stringify(body)).not.toMatch(/stack|\bat .*\(|node_modules/);
    expect(getIncomeStatement).not.toHaveBeenCalled();
    expect(getIncomeStatementByDimension).not.toHaveBeenCalled();
  });

  it('a valid range is 200 with the report body unchanged', async () => {
    const res = response();
    await reportHandler(req({}), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(getIncomeStatement).toHaveBeenCalledWith(companyId, '2026-04-01', '2026-04-30', expect.any(Object), undefined);
    expect((res.json.mock.calls[0]![0] as { data: unknown }).data).toEqual(report);
  });

  it('a valid compare window is passed through', async () => {
    const res = response();
    await reportHandler(req({ compare_start: '2026-03-01', compare_end: '2026-03-31' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(getIncomeStatement).toHaveBeenCalledWith(companyId, '2026-04-01', '2026-04-30', expect.any(Object),
      { start: '2026-03-01', end: '2026-03-31' });
  });
});
