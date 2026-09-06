/**
 * pages/api/accounting/reports-account-trends is a thin passthrough onto
 * trendRowsService — these guards hold the query validation and basis
 * dispatch (movement vs balance), which a source grep cannot verify.
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

const getMonthlyMovements = vi.fn();
const getMonthlyBalances = vi.fn();
vi.mock('@/modules/accounting/services/reports/trendRowsService', () => ({
  getMonthlyMovements: (...a: unknown[]) => getMonthlyMovements(...a),
  getMonthlyBalances: (...a: unknown[]) => getMonthlyBalances(...a),
}));

import handler from '../../../pages/api/accounting/reports-account-trends';

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

beforeEach(() => {
  vi.clearAllMocks();
  getMonthlyMovements.mockResolvedValue({ months: ['2026-08'], byAccountCode: {}, unavailable: {} });
  getMonthlyBalances.mockResolvedValue({ months: ['2026-08'], byAccountCode: {}, unavailable: {} });
});

describe('reports-account-trends', () => {
  it('rejects a non-GET method', async () => {
    const req = { method: 'POST', query: {}, companyId: COMPANY } as unknown as NextApiRequest;
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects a malformed as_of', async () => {
    const req = { method: 'GET', query: { as_of: 'not-a-date' }, companyId: COMPANY } as unknown as NextApiRequest;
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(422);
    expect(getMonthlyMovements).not.toHaveBeenCalled();
  });

  it('defaults basis to movement', async () => {
    const req = { method: 'GET', query: { as_of: '2026-08-31' }, companyId: COMPANY } as unknown as NextApiRequest;
    const res = mockRes();
    await handler(req, res);
    expect(getMonthlyMovements).toHaveBeenCalledWith(COMPANY, '2026-08-31');
    expect(getMonthlyBalances).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('dispatches to balances when basis=balance', async () => {
    const req = {
      method: 'GET',
      query: { as_of: '2026-08-31', basis: 'balance' },
      companyId: COMPANY,
    } as unknown as NextApiRequest;
    const res = mockRes();
    await handler(req, res);
    expect(getMonthlyBalances).toHaveBeenCalledWith(COMPANY, '2026-08-31');
    expect(getMonthlyMovements).not.toHaveBeenCalled();
  });

  it('rejects an invalid basis value', async () => {
    const req = {
      method: 'GET',
      query: { as_of: '2026-08-31', basis: 'nonsense' },
      companyId: COMPANY,
    } as unknown as NextApiRequest;
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(422);
  });

  it('returns the trends payload in the envelope', async () => {
    const req = { method: 'GET', query: { as_of: '2026-08-31' }, companyId: COMPANY } as unknown as NextApiRequest;
    const res = mockRes();
    await handler(req, res);
    expect((res.sent as { data: unknown }).data).toEqual({
      months: ['2026-08'], byAccountCode: {}, unavailable: {},
    });
  });
});
