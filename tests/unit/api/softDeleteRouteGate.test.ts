/** #1656 round 4 (F-M4): the soft-delete route passes what the person may do (allowReversal) and answers the service's refusal 403. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({ ...(await orig<object>()), mayApprove: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/softDeleteService', async (orig) => ({
  ...(await orig<object>()), softDelete: vi.fn(async () => ({ undoToken: 'x' })), undoDelete: vi.fn(async () => true),
}));

import { mayApprove, ApprovePermissionError } from '@/modules/accounting/services/core/approvePermission';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import handler from '../../../pages/api/accounting/soft-delete';

const C = '11111111-1111-4111-8111-111111111111';
const ID = '66666666-6666-4666-8666-666666666666';
function call(method: string, entityType: string) {
  const req = { method, query: {}, body: { entityType, entityId: ID }, companyId: C, user: { id: 'u-1' } } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; } };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
beforeEach(() => vi.clearAllMocks());

describe('soft-delete passes allowReversal from the person\'s Approve on the invoice\'s module', () => {
  it.each([['customer_invoice', 'customers'], ['supplier_invoice', 'suppliers']])('%s asks %s', async (type, module) => {
    vi.mocked(mayApprove).mockResolvedValueOnce(false);
    await call('POST', type);
    expect(mayApprove).toHaveBeenCalledWith(C, 'u-1', module);
    expect(vi.mocked(softDelete).mock.calls[0]?.[4]).toEqual({ allowReversal: false });
    vi.mocked(mayApprove).mockResolvedValueOnce(true);
    await call('PUT', type);
    expect(vi.mocked(undoDelete).mock.calls[0]?.[4]).toEqual({ allowReversal: true });
  });

  it('anything but an invoice reverses nothing and asks nothing', async () => {
    await call('POST', 'customer');
    expect(mayApprove).not.toHaveBeenCalled();
    expect(vi.mocked(softDelete).mock.calls[0]?.[4]).toEqual({ allowReversal: true });
  });

  it('the service refusing under its lock is a 403 on delete and on undo', async () => {
    vi.mocked(softDelete).mockRejectedValueOnce(new ApprovePermissionError('customers', 'invoice deletions'));
    expect((await call('POST', 'customer_invoice')).statusCode).toBe(403);
    vi.mocked(undoDelete).mockRejectedValueOnce(new ApprovePermissionError('suppliers', 'invoice deletions'));
    expect((await call('PUT', 'supplier_invoice')).statusCode).toBe(403);
  });
});
