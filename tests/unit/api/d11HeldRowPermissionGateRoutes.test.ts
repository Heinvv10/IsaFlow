/**
 * #1656: the held-row route tests (d11HeldRow*Routes) grant the per-module permission gate so they can reach the
 * held-row path. This file is the other half: a person WITHOUT the module permission is answered 403 by each route
 * family's gate before the route reads or writes anything (`sql` is never called), and the gate asks the right module
 * and action. The gate's own rule (owner/admin always, stored role, per-user row) is proven in approvePermissionPaths,
 * payrollModuleCensus and the integration suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h, withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: vi.fn().mockResolvedValue(true), checkRateLimit: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/als', () => ({ als: { getStore: vi.fn() }, assertTxUsable: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn(), withTransaction: vi.fn() }));

import { sql } from '@/lib/neon';
import { checkPermission } from '@/lib/auth/permissionService';
import payrollCalculate from '../../../pages/api/payroll/runs/[id]/calculate';
import payrollApprove from '../../../pages/api/payroll/runs/[id]/approve';
import recurringInvoicesRun from '../../../pages/api/accounting/recurring-invoices-run';
import belowThreshold from '../../../pages/api/accounting/assets/below-threshold';
import bankAction from '../../../pages/api/accounting/bank-transactions-action';
import receiptMatchConfirm from '../../../pages/api/accounting/ar/receipt-match/confirm';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '99999999-9999-4999-8999-999999999999';
const ID = '66666666-6666-4666-8666-666666666666';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

function call(handler: Handler, body: unknown) {
  const req = { method: 'POST', query: { id: ID }, body, companyId: COMPANY, user: { id: USER } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, send(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(checkPermission).mockResolvedValue(false); });

describe('a person without the module permission is refused 403 before any read or write', () => {
  it.each([
    ['payroll/runs/[id]/calculate (Payroll module, write)', payrollCalculate, {}, 'payroll', 'write'],
    ['payroll/runs/[id]/approve (Payroll module, write)', payrollApprove, { expectedPlanHash: 'h' }, 'payroll', 'write'],
    ['recurring-invoices-run (Customers approve)', recurringInvoicesRun, {}, 'customers', 'approve'],
    ['assets/below-threshold (Chart of Accounts approve)', belowThreshold, { assetId: ID }, 'accounts', 'approve'],
    ['bank-transactions-action reverse (Banking approve)', bankAction, { action: 'reverse', bankTransactionId: ID }, 'banking', 'approve'],
    ['ar/receipt-match/confirm (Banking approve)', receiptMatchConfirm, {}, 'banking', 'approve'],
  ] as const)('%s', async (_name, handler, body, moduleKey, action) => {
    const r = await call(handler as Handler, body);
    expect(r.statusCode, JSON.stringify(r.sent)).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(COMPANY, USER, moduleKey, action);
    expect(sql).not.toHaveBeenCalled();
  });

  it('payroll approve: a person with Payroll write but without Approve passes the module gate and is refused by the Approve gate', async () => {
    vi.mocked(checkPermission).mockImplementation(async (_c, _u, _m, action) => action !== 'approve');
    const r = await call(payrollApprove as Handler, { expectedPlanHash: 'h' });
    expect(r.statusCode, JSON.stringify(r.sent)).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(COMPANY, USER, 'payroll', 'write');
    expect(checkPermission).toHaveBeenCalledWith(COMPANY, USER, 'payroll', 'approve');
    expect(sql).not.toHaveBeenCalled();
  });
});
