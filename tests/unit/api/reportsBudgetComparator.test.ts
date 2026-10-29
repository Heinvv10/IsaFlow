/**
 * pages/api/accounting/reports-budget-comparator wraps getBudgetVariance and
 * concatenates rows + unbudgeted into one `lines` array — the ordering (and
 * that unbudgeted accounts aren't dropped) is the thing a source grep cannot
 * verify.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
type Verdict = { admitted: boolean; retryAfterSecs: number | null };
const chargeReportRateLimit = vi.fn(async (): Promise<Verdict> => ({ admitted: true, retryAfterSecs: null }));
vi.mock('@/lib/rateLimit', () => ({
  chargeReportRateLimit: (...a: unknown[]) => chargeReportRateLimit(...(a as [])),
  INTERACTIVE_REPORT_LIMIT: { max: 120, windowSecs: 900 },
}));

const getBudgetVariance = vi.fn();
vi.mock('@/modules/accounting/services/reports/budgetVarianceService', () => ({
  getBudgetVariance: (...a: unknown[]) => getBudgetVariance(...a),
}));

import handler from '../../../pages/api/accounting/reports-budget-comparator';

const COMPANY = '11111111-1111-4111-8111-111111111111';

function mockRes() {
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

const BUDGETED = { account_id: 'a1', account_code: '4000', budget: 100 };
const UNBUDGETED = { account_id: 'a2', account_code: '5000', budget: 0 };
const VERSION = { id: 'v1', name: 'Original', kind: 'original', status: 'approved', isPrimary: true };
const CC = '22222222-2222-4222-8222-222222222222';
const BU = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const get = (query: Record<string, unknown>) => ({ method: 'GET', query, companyId: COMPANY } as unknown as NextApiRequest);
const WINDOW = { period_start: '2026-08-01', period_end: '2026-08-31' };

beforeEach(() => {
  vi.clearAllMocks();
  chargeReportRateLimit.mockResolvedValue({ admitted: true, retryAfterSecs: null });
  getBudgetVariance.mockResolvedValue({
    fiscalYear: 2026,
    monthKeys: ['2026-08'],
    rows: [BUDGETED],
    unbudgeted: [UNBUDGETED],
    universeTotal: 2,
    totals: { budget: 100, actual: 90, variance: -10 },
    unbudgetedMovement: 5,
    postedThrough: '2026-08-31',
    version: VERSION,
    unallocatedBudget: { income: 0, expense: 1200 },
    noBudgetYears: [],
    partialBudgetCount: 2,
  });
});

describe('reports-budget-comparator', () => {
  it('rejects a non-GET method', async () => {
    const req = { method: 'POST', query: {}, companyId: COMPANY } as unknown as NextApiRequest;
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects a missing period_end', async () => {
    const req = {
      method: 'GET',
      query: { period_start: '2026-08-01' },
      companyId: COMPANY,
    } as unknown as NextApiRequest;
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(422);
    expect(getBudgetVariance).not.toHaveBeenCalled();
  });

  it('calls getBudgetVariance with companyId and the window', async () => {
    const req = {
      method: 'GET',
      query: { period_start: '2026-08-01', period_end: '2026-08-31' },
      companyId: COMPANY,
    } as unknown as NextApiRequest;
    const res = mockRes();
    await handler(req, res);
    expect(getBudgetVariance).toHaveBeenCalledWith(COMPANY, '2026-08-01', '2026-08-31', {});
    expect(res.statusCode).toBe(200);
  });

  it('concatenates budgeted rows before unbudgeted ones, and keeps both', async () => {
    const req = {
      method: 'GET',
      query: { period_start: '2026-08-01', period_end: '2026-08-31' },
      companyId: COMPANY,
    } as unknown as NextApiRequest;
    const res = mockRes();
    await handler(req, res);
    const body = res.sent as { data: { lines: unknown[]; fiscalYear: number; monthKeys: string[]; postedThrough: string | null } };
    expect(body.data.lines).toEqual([BUDGETED, UNBUDGETED]);
    expect(body.data.fiscalYear).toBe(2026);
    expect(body.data.monthKeys).toEqual(['2026-08']);
    expect(body.data.postedThrough).toBe('2026-08-31');
  });

  it('passes the filter and the version: cost_centre_id (either level), cc1_id, cc2_id, bu_id, version_id', async () => {
    await handler(get({ ...WINDOW, cost_centre_id: CC, bu_id: BU, version_id: V }), mockRes());
    expect(getBudgetVariance).toHaveBeenCalledWith(COMPANY, '2026-08-01', '2026-08-31', { costCentreId: CC, buId: BU, versionId: V });
    await handler(get({ ...WINDOW, cc1_id: CC, cc2_id: BU }), mockRes());
    expect(getBudgetVariance).toHaveBeenLastCalledWith(COMPANY, '2026-08-01', '2026-08-31', { cc1Id: CC, cc2Id: BU });
  });

  it('business_unit_id (the income statement page\'s name) is bu_id; both naming different units is a 400', async () => {
    await handler(get({ ...WINDOW, business_unit_id: BU }), mockRes());
    expect(getBudgetVariance).toHaveBeenCalledWith(COMPANY, '2026-08-01', '2026-08-31', { buId: BU });
    const res = mockRes();
    await handler(get({ ...WINDOW, business_unit_id: BU, bu_id: CC }), res);
    expect(res.statusCode).toBe(400);
    expect(getBudgetVariance).toHaveBeenCalledTimes(1);
  });

  it('a blank filter value is absent; a malformed id is refused before the service', async () => {
    await handler(get({ ...WINDOW, cost_centre_id: '', business_unit_id: '' }), mockRes());
    expect(getBudgetVariance).toHaveBeenCalledWith(COMPANY, '2026-08-01', '2026-08-31', {});
    const res = mockRes();
    await handler(get({ ...WINDOW, cost_centre_id: 'not-a-uuid' }), res);
    expect(res.statusCode).toBe(422);
    expect(getBudgetVariance).toHaveBeenCalledTimes(1);
  });

  it('answers with the version, the unallocated budget and the years with no budget in the window', async () => {
    const res = mockRes();
    await handler(get(WINDOW), res);
    const body = res.sent as { data: Record<string, unknown> };
    expect(body.data.version).toEqual(VERSION);
    expect(body.data.unallocatedBudget).toEqual({ income: 0, expense: 1200 });
    expect(body.data.noBudgetYears).toEqual([]);
    expect(body.data.partialBudgetCount).toBe(2);
    expect(body.data.budgetedCount).toBe(1);
  });

  it("an engine refusal keeps its status (another company's centre is a 404)", async () => {
    const { TrackingError } = await import('@/modules/accounting/services/budgets/tracking/trackingTypes');
    getBudgetVariance.mockRejectedValueOnce(new TrackingError(404, `Cost centre ${CC} not found`));
    const res = mockRes();
    await handler(get({ ...WINDOW, cost_centre_id: CC }), res);
    expect(res.statusCode).toBe(404);
  });

  it('is charged at the interactive limit, and a refusal says how long to wait (Retry-After and the message)', async () => {
    chargeReportRateLimit.mockResolvedValue({ admitted: false, retryAfterSecs: 250 });
    const res = mockRes();
    await handler(get(WINDOW), res);
    expect(chargeReportRateLimit).toHaveBeenCalledWith(COMPANY, 'reports-budget-comparator', { max: 120, windowSecs: 900 });
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('250');
    expect(JSON.stringify(res.sent)).toContain('try again in 5 minutes');
    expect(getBudgetVariance).not.toHaveBeenCalled();
  });

  it('a refusal with no known wait still says to try again, with no Retry-After', async () => {
    chargeReportRateLimit.mockResolvedValue({ admitted: false, retryAfterSecs: null });
    const res = mockRes();
    await handler(get(WINDOW), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeUndefined();
  });
});
