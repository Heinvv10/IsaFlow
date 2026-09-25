/**
 * R-126: PUT on a purchase order read its status, then UPDATEd without the
 * status in the WHERE. A status change in between (say submitted -> approved)
 * let the edit land on an order that was no longer editable. The UPDATE now
 * carries the guard; when it matches no row, a company-scoped re-read decides
 * the answer: 404 gone, 400 naming the status, 409 if it is editable again.
 *
 * The mocked sql answers the pre-read "editable" and the UPDATE with no row,
 * which is exactly what the database does when the status moves in between.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: mocks.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (handler: unknown) => handler,
  withWriteAccess: (handler: unknown) => handler,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertSupplierInCompany: vi.fn(async () => undefined),
  SupplierNotInCompanyError: class extends Error {},
}));
vi.mock('@/modules/accounting/services/gl/documentLineAccountGuard', () => ({
  assertDocumentLineAccounts: vi.fn(async () => undefined),
  DocumentLineAccountRefusal: class extends Error {},
}));

import handler from '../../../pages/api/accounting/purchase-orders/[id]';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PO = '22222222-2222-4222-8222-222222222222';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
}
const put = () =>
  ({ method: 'PUT', companyId: COMPANY, user: { id: 'u1' }, query: { id: PO }, body: { notes: 'x' } }) as unknown as NextApiRequest;
const status = (res: NextApiResponse) => vi.mocked(res.status).mock.calls[0]?.[0];
const text = (res: NextApiResponse) => JSON.stringify(vi.mocked(res.json).mock.calls[0]?.[0]);
const sqlText = (call: number) => (mocks.sql.mock.calls[call]![0] as TemplateStringsArray).join('?');

describe('purchase-order PUT — status changes between the read and the UPDATE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockReset();
    mocks.sql
      .mockResolvedValueOnce([{ id: PO, status: 'submitted' }]) // pre-read: editable
      .mockResolvedValueOnce([]);                                // guarded UPDATE: no row
  });

  it('answers 400 naming the status the order moved to', async () => {
    mocks.sql.mockResolvedValueOnce([{ id: PO, status: 'approved' }]); // re-read
    const res = response();
    await handler(put(), res);
    expect(status(res)).toBe(400);
    expect(text(res)).toContain('approved');
    expect(mocks.sql).toHaveBeenCalledTimes(3);
    // The re-read is scoped to the caller's company.
    expect(sqlText(2)).toContain('FROM purchase_orders');
    expect(mocks.sql.mock.calls[2]!.slice(1)).toEqual([PO, COMPANY]);
  });

  it('answers 409 when the re-read finds the order editable again', async () => {
    mocks.sql.mockResolvedValueOnce([{ id: PO, status: 'draft' }]);
    const res = response();
    await handler(put(), res);
    expect(status(res)).toBe(409);
    expect(text(res)).toContain('reload');
  });

  it('answers 404 when the order is gone', async () => {
    mocks.sql.mockResolvedValueOnce([]);
    const res = response();
    await handler(put(), res);
    expect(status(res)).toBe(404);
  });

  it('still saves when the UPDATE matches the order', async () => {
    mocks.sql.mockReset();
    mocks.sql
      .mockResolvedValueOnce([{ id: PO, status: 'draft' }])
      .mockResolvedValueOnce([{ id: PO, status: 'draft', notes: 'x' }])
      .mockResolvedValueOnce([]); // po_items re-read
    const res = response();
    await handler(put(), res);
    expect(status(res)).toBe(200);
    expect(text(res)).toContain('"notes":"x"');
  });
});
