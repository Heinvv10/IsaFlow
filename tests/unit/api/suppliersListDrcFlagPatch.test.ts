/**
 * PATCH /api/accounting/suppliers-list — the supplier "subject to DRC VAT" flag.
 *
 * The route deliberately edits this ONE field: there is no supplier edit
 * screen, and a general update route would put bank details one request away
 * from any writer. These pin that only the flag reaches the service, whatever
 * else the body carries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ updateSupplier: vi.fn(), invalidate: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (handler: unknown) => handler,
  withWriteAccess: (handler: unknown) => handler,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/lib/cache', () => ({ cache: { invalidate: mocks.invalidate }, cacheThrough: vi.fn() }));
vi.mock('@/modules/accounting/services/core/supplierWriteService', () => ({
  createSupplier: vi.fn(),
  updateSupplier: mocks.updateSupplier,
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ listSuppliers: vi.fn() }));

import handler from '../../../pages/api/accounting/suppliers-list';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
}
const patch = (body: Record<string, unknown>) =>
  ({ method: 'PATCH', companyId: COMPANY, user: { id: 'u' }, query: {}, body }) as unknown as NextApiRequest;
const status = (res: NextApiResponse) => vi.mocked(res.status).mock.calls[0]?.[0];

describe('suppliers-list PATCH — the DRC flag only', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes ONLY subjectToDrcVat to the service, even when the body carries bank details', async () => {
    mocks.updateSupplier.mockResolvedValueOnce({ id: SUPPLIER, subject_to_drc_vat: true });
    const res = response();
    await handler(patch({ id: SUPPLIER, subject_to_drc_vat: true, bank_account_number: '999', name: 'x' }), res);
    expect(mocks.updateSupplier).toHaveBeenCalledWith(COMPANY, SUPPLIER, { subjectToDrcVat: true });
    expect(status(res)).toBe(200);
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  it('refuses a missing id or a non-boolean flag before any write', async () => {
    for (const body of [{ subject_to_drc_vat: true }, { id: 'nope', subject_to_drc_vat: true },
      // 36 characters of hex and hyphens, but not a UUID: must be a 400, not a 22P02 500.
      { id: '------------------------------------', subject_to_drc_vat: true },
      { id: SUPPLIER, subject_to_drc_vat: 'yes' }, { id: SUPPLIER }]) {
      const res = response();
      await handler(patch(body), res);
      expect(status(res)).toBe(400);
    }
    // A JSON null body is a 400, not a TypeError 500.
    const res = response();
    await handler({ method: 'PATCH', companyId: COMPANY, user: { id: 'u' }, query: {}, body: null } as unknown as NextApiRequest, res);
    expect(status(res)).toBe(400);
    expect(mocks.updateSupplier).not.toHaveBeenCalled();
  });

  it('answers 404 when the supplier is not in this company', async () => {
    mocks.updateSupplier.mockResolvedValueOnce(null);
    const res = response();
    await handler(patch({ id: SUPPLIER, subject_to_drc_vat: false }), res);
    expect(status(res)).toBe(404);
  });
});
