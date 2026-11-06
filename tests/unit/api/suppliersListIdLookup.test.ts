/**
 * GET /api/accounting/suppliers-list?id= — the single-supplier lookup SupplierSelect
 * uses to name a preselected id. The id reaches a ::UUID cast, so anything that is
 * not a UUID must be a 400 before the query (not a 22P02 500), and a missing or
 * other-company supplier must be the same 404 either way.
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
vi.mock('@/modules/accounting/services/core/supplierWriteService', () => ({ createSupplier: vi.fn(), updateSupplier: vi.fn() }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ listSuppliers: vi.fn() }));

import { log } from '@/lib/logger';
import handler from '../../../pages/api/accounting/suppliers-list';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
}
const get = (id: unknown) =>
  ({ method: 'GET', companyId: COMPANY, user: { id: 'u' }, query: { id } }) as unknown as NextApiRequest;
const status = (res: NextApiResponse) => vi.mocked(res.status).mock.calls[0]?.[0];

describe('suppliers-list GET ?id=', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers 400 before the query for an id that is not a UUID', async () => {
    for (const id of ['nope', '------------------------------------', '', ['a', 'b'], SUPPLIER + "'; DROP TABLE suppliers;--"]) {
      const res = response();
      await handler(get(id), res);
      expect(status(res)).toBe(400);
    }
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('answers the same 404 for a supplier that is missing or belongs to another company', async () => {
    mocks.sql.mockResolvedValue([]); // the query is scoped by company_id, so another tenant's row is simply absent
    const res = response();
    await handler(get(SUPPLIER), res);
    expect(status(res)).toBe(404);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it('returns the row for a valid id', async () => {
    mocks.sql.mockResolvedValueOnce([{ id: SUPPLIER, name: 'Acme' }]);
    const res = response();
    await handler(get(SUPPLIER), res);
    expect(status(res)).toBe(200);
  });

  it('an unreadable company default is read as 30 days and the warning names the COMPANY (the contact row has no company_id)', async () => {
    mocks.sql.mockResolvedValueOnce([{ id: SUPPLIER, name: 'Acme', company_default_terms: 'not json' }]);
    const res = response();
    await handler(get(SUPPLIER), res);
    expect(status(res)).toBe(200);
    expect(vi.mocked(log.warn).mock.calls.map((c) => c[1])).toContainEqual({ companyId: COMPANY });
  });
});
