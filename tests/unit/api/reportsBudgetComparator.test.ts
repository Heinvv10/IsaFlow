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
vi.mock('@/lib/rateLimit', () => ({
  checkReportRateLimit: vi.fn(async () => true),
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
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
    setHeader() { return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

const BUDGETED = { account_id: 'a1', account_code: '4000', budget: 100 };
const UNBUDGETED = { account_id: 'a2', account_code: '5000', budget: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  getBudgetVariance.mockResolvedValue({
    fiscalYear: 2026,
    monthKeys: ['2026-08'],
    rows: [BUDGETED],
    unbudgeted: [UNBUDGETED],
    universeTotal: 2,
    totals: { budget: 100, actual: 90, variance: -10 },
    unbudgetedMovement: 5,
    postedThrough: '2026-08-31',
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
    expect(getBudgetVariance).toHaveBeenCalledWith(COMPANY, '2026-08-01', '2026-08-31');
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
});
