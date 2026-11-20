/**
 * #1656 round 7 (breaker M5): /api/accounting/approval-requests is an Accounting route, but a `pay_run` request names a payroll run and its
 * listing carries the run's amount. So: raising one, and rejecting one, need Payroll WRITE (as every other payroll write does); listing them,
 * and the advisory check of one, need Payroll READ (the items without it simply leave the pay_run requests out). Approving stays the module
 * Approve gate (refuseApprovalRequestWithoutApprove). A request for any other document never asks Payroll.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
const state = vi.hoisted(() => ({ requestRow: { document_type: 'pay_run', document_id: '22222222-2222-4222-8222-222222222222' } as Record<string, string> | undefined }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => (state.requestRow ? [state.requestRow] : [])) }));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalControl', () => ({ preparePayRunApprovalRequest: vi.fn(async () => 'hash') }));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalAudit', () => ({ recordPayRunApprovalAudit: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/approvePermissionResponse', async (orig) => ({ ...(await orig<object>()), refuseApprovalRequestWithoutApprove: vi.fn(async () => false) }));
vi.mock('@/modules/accounting/services/gl/approvalDocuments', async (orig) => ({
  ...(await orig<object>()),
  requestApproval: vi.fn(async () => ({ id: 'req1' })),
  resolveApprovalDocument: vi.fn(async () => ({ amount: 1000 })),
}));
vi.mock('@/modules/accounting/services/gl/approvalService', async (orig) => ({
  ...(await orig<object>()),
  requestApproval: vi.fn(async () => ({ id: 'req1' })),
  decideRequest: vi.fn(async () => ({ id: 'req1', documentDigest: null })),
  checkApproval: vi.fn(async () => ({ required: false })),
  listRequests: vi.fn(async () => [
    { id: 'a', documentType: 'pay_run', amount: 250000 },
    { id: 'b', documentType: 'supplier_invoice', amount: 900 },
  ]),
}));

import { checkPermission } from '@/lib/auth/permissionService';
import { preparePayRunApprovalRequest } from '@/modules/accounting/services/payroll/payRunApprovalControl';
import { decideRequest, listRequests, requestApproval } from '@/modules/accounting/services/gl/approvalService';
import handler from '../../../pages/api/accounting/approval-requests';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const RUN = '22222222-2222-4222-8222-222222222222';
const REQ = '44444444-4444-4444-8444-444444444444';
let allowed: { read: boolean; write: boolean };

function call(method: string, query: Record<string, unknown>, body?: Record<string, unknown>) {
  const req = { method, query, body, companyId: C, companyRole: 'manager', user: { id: U }, headers: {}, cookies: {} } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  return Promise.resolve((handler as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}
const items = (res: { sent: unknown }) => ((res.sent as { data: { items: Array<{ id: string }> } }).data.items).map((i) => i.id);

beforeEach(() => {
  vi.clearAllMocks();
  state.requestRow = { document_type: 'pay_run', document_id: RUN };
  allowed = { read: false, write: false };
  vi.mocked(checkPermission).mockImplementation(async (_c, _u, module, action) => module !== 'payroll' || (action === 'read' ? allowed.read : allowed.write));
});

describe('raising a pay_run approval request', () => {
  it('without Payroll write: 403, and neither the plan nor the request is touched', async () => {
    const res = await call('POST', {}, { action: 'request', documentType: 'pay_run', documentId: RUN });
    expect(res.statusCode).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, 'payroll', 'write');
    expect(preparePayRunApprovalRequest).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
  });
  it('with Payroll write it goes through; a supplier invoice never asks Payroll', async () => {
    allowed.write = true;
    expect((await call('POST', {}, { action: 'request', documentType: 'pay_run', documentId: RUN })).statusCode).toBe(200);
    vi.mocked(checkPermission).mockClear();
    allowed.write = false;
    expect((await call('POST', {}, { action: 'request', documentType: 'supplier_invoice', documentId: RUN })).statusCode).toBe(200);
    expect(checkPermission).not.toHaveBeenCalled();
  });
});

describe('rejecting a pay_run request', () => {
  it('without Payroll write: 403 and nothing is decided', async () => {
    const res = await call('POST', {}, { action: 'reject', requestId: REQ });
    expect(res.statusCode).toBe(403);
    expect(decideRequest).not.toHaveBeenCalled();
  });
  it('with Payroll write it is decided; rejecting another document type never asks Payroll', async () => {
    allowed.write = true;
    expect((await call('POST', {}, { action: 'reject', requestId: REQ })).statusCode).toBe(200);
    vi.mocked(decideRequest).mockClear();
    vi.mocked(checkPermission).mockClear();
    state.requestRow = { document_type: 'supplier_invoice', document_id: RUN };
    allowed.write = false;
    expect((await call('POST', {}, { action: 'reject', requestId: REQ })).statusCode).toBe(200);
    expect(decideRequest).toHaveBeenCalledTimes(1);
    expect(checkPermission).not.toHaveBeenCalled();
  });
});

describe('listing and checking', () => {
  it('without Payroll read the list leaves the pay_run requests (and their amounts) out; with it they are listed', async () => {
    expect(items(await call('GET', {}))).toEqual(['b']);
    expect(listRequests).toHaveBeenCalledTimes(1);
    allowed.read = true;
    expect(items(await call('GET', {}))).toEqual(['a', 'b']);
  });
  it('the advisory check of a pay_run needs Payroll read; of any other document it does not', async () => {
    const res = await call('GET', { action: 'check', documentType: 'pay_run', documentId: RUN });
    expect(res.statusCode).toBe(403);
    allowed.read = true;
    expect((await call('GET', { action: 'check', documentType: 'pay_run', documentId: RUN })).statusCode).toBe(200);
    vi.mocked(checkPermission).mockClear();
    allowed.read = false;
    expect((await call('GET', { action: 'check', documentType: 'supplier_invoice', documentId: RUN })).statusCode).toBe(200);
    expect(checkPermission).not.toHaveBeenCalled();
  });
});
