/**
 * Budgets P3 PR-B (T10, spec §2.6): reports-account-transactions takes the
 * EXPLICIT dimension levels the Budget vs Actual drill needs, `cc1_id` and
 * `cc2_id`, ANDed with the existing `cost_centre_id` (either level, unchanged)
 * and `business_unit_id`. Each is validated as a UUID before any query and
 * forwarded to the service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({
  getAccountTransactions: vi.fn(async () => ({ transactions: [], openingBalance: 0, closingBalance: 0, periodNet: 0 })),
}));
vi.mock('@/modules/accounting/services/reports/transactionReportingService', () => ({ getAccountTransactions: svc.getAccountTransactions }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/reports-account-transactions';

const CC1 = '00000000-0000-4000-8000-0000000000c1';
const CC2 = '00000000-0000-4000-8000-0000000000c2';
const BU = '00000000-0000-4000-8000-0000000000b1';
const base = { account_code: '4000', period_start: '2026-03-01', period_end: '2026-06-30' };

async function call(query: Record<string, unknown>): Promise<number> {
  const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; }, setHeader() { return this; } };
  await (handler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<unknown>)(
    { method: 'GET', query, companyId: 'c1' } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res.statusCode;
}

beforeEach(() => { svc.getAccountTransactions.mockClear(); });

describe('reports-account-transactions explicit dimension levels', () => {
  it('forwards cc1_id and cc2_id beside business_unit_id (and leaves cost_centre_id as it was)', async () => {
    expect(await call({ ...base, cc1_id: CC1, cc2_id: CC2, business_unit_id: BU })).toBe(200);
    expect(svc.getAccountTransactions).toHaveBeenCalledWith('c1', '4000', '2026-03-01', '2026-06-30', undefined, BU, { cc1Id: CC1, cc2Id: CC2 });
    svc.getAccountTransactions.mockClear();
    expect(await call({ ...base, cost_centre_id: CC1 })).toBe(200);
    expect(svc.getAccountTransactions).toHaveBeenCalledWith('c1', '4000', '2026-03-01', '2026-06-30', CC1, undefined, {});
  });

  it.each([['cc1_id', 'nope'], ['cc2_id', "1' OR 1=1"], ['cc1_id', [CC1, CC1]]])('refuses %s = %j before any query', async (key, value) => {
    expect(await call({ ...base, [key]: value })).toBe(400);
    expect(svc.getAccountTransactions).not.toHaveBeenCalled();
  });
});
