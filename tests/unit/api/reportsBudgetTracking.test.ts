/**
 * pages/api/accounting/reports-budget-tracking (budgets P3 §4): GET only, rate
 * limited per company, every query value validated by zod before the engine
 * runs (malformed = 400), the company taken from the authenticated request and
 * never from the query, and the engine's typed refusals answered with their
 * own status (404 for another tenant's id, 400 for a bad window).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const checkReportRateLimit = vi.fn(async () => true);
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: (...a: unknown[]) => checkReportRateLimit(...(a as [])) }));
const buildBudgetTrackingReport = vi.fn();
vi.mock('@/modules/accounting/services/budgets/tracking/budgetTrackingService', () => ({
  buildBudgetTrackingReport: (...a: unknown[]) => buildBudgetTrackingReport(...a),
}));

import handler from '../../../pages/api/accounting/reports-budget-tracking';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CC = '00000000-0000-0000-0000-0000000000c1';

function mockRes() {
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}
const get = async (query: Record<string, unknown>, method = 'GET') => {
  const res = mockRes();
  await handler({ method, query, companyId: COMPANY } as unknown as NextApiRequest, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  checkReportRateLimit.mockResolvedValue(true);
  buildBudgetTrackingReport.mockResolvedValue({ lines: [], bands: [], marker: 'engine' });
});

describe('reports-budget-tracking', () => {
  it('refuses a non-GET method', async () => {
    expect((await get({}, 'POST')).statusCode).toBe(405);
    expect(buildBudgetTrackingReport).not.toHaveBeenCalled();
  });

  it('honours the per-company report rate limit before any work', async () => {
    checkReportRateLimit.mockResolvedValue(false);
    const res = await get({ period: 'ytd' });
    expect(res.statusCode).toBe(429);
    expect(checkReportRateLimit).toHaveBeenCalledWith(COMPANY, 'reports-budget-tracking');
    expect(buildBudgetTrackingReport).not.toHaveBeenCalled();
  });

  const BAD: Array<[string, Record<string, unknown>]> = [
    ['an unknown period', { period: 'weekly' }],
    ['a month 13', { period: 'month', month: '2026-13' }],
    ['a day-level month', { period: 'month', month: '2026-10-05' }],
    ['a quarter of 9', { period: 'quarter', fiscal_year: '2027', quarter: '9' }],
    ['a quarter that is not a number', { period: 'quarter', fiscal_year: '2027', quarter: 'abc' }],
    ['a fiscal year that is not a label', { period: 'fy', fiscal_year: 'FY27' }],
    ['a day-level custom date', { period: 'custom', from: '2026-01-05', to: '2026-03' }],
    ['a version id that is not a uuid', { version_id: 'nope' }],
    ['a cc1 id that is not a uuid', { cc1_id: "1' OR 1=1" }],
    ['a repeated parameter', { bu_id: [CC, CC] }],
    ['an unknown group_by', { group_by: 'project' }],
    ['a month in year 1', { period: 'month', month: '0001-01' }],
    ['a fiscal year past 2200', { period: 'fy', fiscal_year: '9999' }],
    ['a custom bound past 2200', { period: 'custom', from: '2201-01', to: '2201-03' }],
    ['fiscal_year with period=month', { period: 'month', month: '2026-10', fiscal_year: '2027' }],
    ['quarter without period=quarter', { period: 'ytd', quarter: '2' }],
    ['from/to outside custom', { period: 'fy', from: '2026-01', to: '2026-03' }],
  ];
  for (const [name, query] of BAD) {
    it(`answers ${name} with a 400 and never runs the engine`, async () => {
      const res = await get(query);
      expect(res.statusCode).toBe(400);
      expect(buildBudgetTrackingReport).not.toHaveBeenCalled();
    });
  }

  it("takes the company from the request, never from the query, and maps the query to the engine's params", async () => {
    const res = await get({
      period: 'quarter', fiscal_year: '2027', quarter: '5', version_id: CC, cc1_id: CC, cc2_id: CC, bu_id: CC, group_by: 'cc1', company_id: OTHER,
    });
    expect(res.statusCode).toBe(200);
    expect(buildBudgetTrackingReport).toHaveBeenCalledTimes(1);
    const [company, params] = buildBudgetTrackingReport.mock.calls[0]!;
    expect(company).toBe(COMPANY);
    expect(params).toEqual({ period: 'quarter', fiscalYear: 2027, quarter: 5, versionId: CC, cc1Id: CC, cc2Id: CC, buId: CC, groupBy: 'cc1' });
    expect((res.sent as { data: { marker: string } }).data.marker).toBe('engine');
  });

  it('defaults to year to date; an empty value is absent', async () => {
    await get({ month: '' });
    expect(buildBudgetTrackingReport.mock.calls[0]![1]).toEqual({ period: 'ytd' });
  });

  it("answers the engine's typed refusals with their own status", async () => {
    buildBudgetTrackingReport.mockRejectedValueOnce(new TrackingError(404, 'Cost centre x not found'));
    expect((await get({ cc1_id: CC })).statusCode).toBe(404);
    buildBudgetTrackingReport.mockRejectedValueOnce(new TrackingError(400, 'version X is FY2027; the window reaches FY2028'));
    const r400 = await get({ version_id: CC });
    expect(r400.statusCode).toBe(400);
    expect(JSON.stringify(r400.sent)).toContain('the window reaches FY2028');
    buildBudgetTrackingReport.mockRejectedValueOnce(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found'));
    expect((await get({ version_id: CC })).statusCode).toBe(404);
  });

  it('rethrows anything else (withErrorHandler answers 500 and the request rolls back)', async () => {
    buildBudgetTrackingReport.mockRejectedValueOnce(new Error('boom'));
    await expect(get({})).rejects.toThrow('boom');
  });
});
