/**
 * R-129: DELETE on a purchase order read its status, then deleted without the
 * status in the WHERE. A submit in between let a no-longer-draft order be
 * hard-deleted. The DELETE now carries the guard; when it removes no row, a
 * company-scoped re-read decides the answer: 404 gone, 400 naming the status,
 * 409 if it is a draft again.
 *
 * The mocked sql answers the pre-read "draft" and the DELETE with no row,
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
const del = () =>
  ({ method: 'DELETE', companyId: COMPANY, user: { id: 'u1' }, query: { id: PO }, body: {} }) as unknown as NextApiRequest;
const status = (res: NextApiResponse) => vi.mocked(res.status).mock.calls[0]?.[0];
const text = (res: NextApiResponse) => JSON.stringify(vi.mocked(res.json).mock.calls[0]?.[0]);
const sqlText = (call: number) => (mocks.sql.mock.calls[call]![0] as TemplateStringsArray).join('?');

describe('purchase-order DELETE — status changes between the read and the DELETE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockReset();
    mocks.sql
      .mockResolvedValueOnce([{ id: PO, status: 'draft' }]) // pre-read: deletable
      .mockResolvedValueOnce([]);                            // guarded DELETE: no row
  });

  it('answers 400 naming the status the order moved to', async () => {
    mocks.sql.mockResolvedValueOnce([{ status: 'submitted' }]); // re-read
    const res = response();
    await handler(del(), res);
    expect(status(res)).toBe(400);
    expect(text(res)).toContain('submitted');
    expect(mocks.sql).toHaveBeenCalledTimes(3);
    // The re-read is scoped to the caller's company.
    expect(sqlText(2)).toContain('FROM purchase_orders');
    expect(mocks.sql.mock.calls[2]!.slice(1)).toEqual([PO, COMPANY]);
  });

  it('answers 409 when the re-read finds the order a draft again', async () => {
    mocks.sql.mockResolvedValueOnce([{ status: 'draft' }]);
    const res = response();
    await handler(del(), res);
    expect(status(res)).toBe(409);
    expect(text(res)).toContain('reload');
  });

  it('answers 404 when the order is gone', async () => {
    mocks.sql.mockResolvedValueOnce([]);
    const res = response();
    await handler(del(), res);
    expect(status(res)).toBe(404);
  });

  it('refuses early, without a DELETE, when the pre-read is not draft', async () => {
    mocks.sql.mockReset();
    mocks.sql.mockResolvedValueOnce([{ id: PO, status: 'approved' }]);
    const res = response();
    await handler(del(), res);
    expect(status(res)).toBe(400);
    expect(text(res)).toContain('approved');
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it('answers 200 when the DELETE removes the order', async () => {
    mocks.sql.mockReset();
    mocks.sql
      .mockResolvedValueOnce([{ id: PO, status: 'draft' }])
      .mockResolvedValueOnce([{ id: PO }]);
    const res = response();
    await handler(del(), res);
    expect(status(res)).toBe(200);
    expect(mocks.sql).toHaveBeenCalledTimes(2);
  });
});
