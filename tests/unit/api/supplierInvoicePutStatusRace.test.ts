/**
 * K-137 follow-up: the PUT's guarded UPDATE matched no row, but by the time
 * the handler re-reads the invoice its status is editable again. Answering
 * "only drafts can be edited" about a draft would be wrong; the caller gets a
 * 409 and is told to reload instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ sql: vi.fn(), getById: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: mocks.sql, withSavepoint: (_name: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (handler: unknown) => handler,
  withWriteAccess: (handler: unknown) => handler,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({ getSupplierInvoiceById: mocks.getById }));
// R-035 LOW-1: the edit locks the row before reading its digest; the lock has its own integration test.
vi.mock('@/modules/accounting/services/ap/supplierInvoiceLock', () => ({ lockSupplierInvoiceForUpdate: async () => null }));

import handler from '../../../pages/api/accounting/supplier-invoices-detail';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const INVOICE = '22222222-2222-4222-8222-222222222222';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
}
const put = () =>
  ({ method: 'PUT', companyId: COMPANY, user: { id: '33333333-3333-4333-8333-333333333333' }, query: {}, body: { id: INVOICE, notes: 'x' } }) as unknown as NextApiRequest;
const status = (res: NextApiResponse) => vi.mocked(res.status).mock.calls[0]?.[0];
const text = (res: NextApiResponse) => JSON.stringify(vi.mocked(res.json).mock.calls[0]?.[0]);

describe('supplier-invoice PUT — zero-row UPDATE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockResolvedValue([]); // the guarded UPDATE matched nothing
  });

  it('answers 409 when the re-read finds the invoice editable again', async () => {
    mocks.getById.mockResolvedValueOnce({ id: INVOICE, status: 'draft' });
    const res = response();
    await handler(put(), res);
    expect(mocks.getById).toHaveBeenCalledWith(COMPANY, INVOICE);
    expect(status(res)).toBe(409);
    expect(text(res)).toContain('reload');
  });

  it('answers 400 naming the status when the invoice is not editable', async () => {
    mocks.getById.mockResolvedValueOnce({ id: INVOICE, status: 'paid' });
    const res = response();
    await handler(put(), res);
    expect(status(res)).toBe(400);
    expect(text(res)).toContain('paid');
  });
});
