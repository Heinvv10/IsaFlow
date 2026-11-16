/**
 * GET /api/accounting/bank-account-summaries (WP1 PR-B): GET only (405 otherwise, nothing read), no query parameters
 * (whatever the caller sends, the service gets the company and nothing else — in particular no asAt), the service's
 * result returned unchanged, and a failed read is a 500 through the real withErrorHandler. Auth is a pass-through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const getBankAccountSummaries = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankAccountSummaryService', () => ({
  getBankAccountSummaries: (...a: unknown[]) => getBankAccountSummaries(...a),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => { throw new Error('the route must not query directly'); }) }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/bank-account-summaries';

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001';

function call(query: Record<string, string>, method = 'GET') {
  const req = { method, query, url: '/api/accounting/bank-account-summaries', headers: {}, companyId: COMPANY } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, body: undefined as unknown, headers: {} as Record<string, unknown>,
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    end(payload?: unknown) { this.body = payload; return this; },
  };
  return (handler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, res as unknown as NextApiResponse)
    .then(() => res);
}

beforeEach(() => { getBankAccountSummaries.mockReset(); });

describe('GET /api/accounting/bank-account-summaries', () => {
  it('returns the service result for the company, unchanged', async () => {
    const result = { asAt: '2026-11-15', accounts: [{ id: 'b1', ledgerCents: 886544 }] };
    getBankAccountSummaries.mockResolvedValue(result);
    const res = await call({});
    expect(res.statusCode).toBe(200);
    expect(getBankAccountSummaries).toHaveBeenCalledWith(COMPANY);
    expect((res.body as { data: unknown }).data).toEqual(result);
  });

  it('ignores query parameters: an asAt or a company in the URL never reaches the service', async () => {
    getBankAccountSummaries.mockResolvedValue({ asAt: '2026-11-15', accounts: [] });
    const res = await call({ asAt: '2020-01-01', companyId: 'bbbbbbbb-0000-4000-8000-000000000002', bankAccountId: 'x' });
    expect(res.statusCode).toBe(200);
    expect(getBankAccountSummaries.mock.calls).toEqual([[COMPANY]]);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s is a 405 and reads nothing', async (method) => {
    const res = await call({}, method);
    expect(res.statusCode).toBe(405);
    expect(getBankAccountSummaries).not.toHaveBeenCalled();
  });

  it('a failed read is a 500', async () => {
    getBankAccountSummaries.mockRejectedValue(new Error('connection terminated'));
    const res = await call({});
    expect(res.statusCode).toBe(500);
  });
});
