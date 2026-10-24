/**
 * GET /api/accounting/customers — the two additions the shared ContactPicker needs:
 *   ?id=<uuid>   one customer (names a preselected id that is not in the first page)
 *   ?limit=<n>   a short first page (the picker must not load the directory to open)
 * `?id=` that is not a UUID keeps its old meaning (the full list), and `?id=&include=activity` is untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ sql: vi.fn(), listCustomers: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: mocks.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/customerWriteService', () => ({
  createCustomer: vi.fn(), ContactValidationError: class ContactValidationError extends Error {},
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ listCustomers: mocks.listCustomers }));

import handler from '../../../pages/api/accounting/customers';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
}
const get = (query: Record<string, unknown>) =>
  ({ method: 'GET', companyId: COMPANY, user: { id: 'u' }, query }) as unknown as NextApiRequest;
const status = (res: NextApiResponse) => vi.mocked(res.status).mock.calls[0]?.[0];
const body = (res: NextApiResponse) => vi.mocked(res.json).mock.calls[0]?.[0] as { data: unknown };

describe('customers GET ?id=', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.listCustomers.mockResolvedValue([]); });

  it('returns the one row for a valid id', async () => {
    mocks.sql.mockResolvedValueOnce([{ id: CUSTOMER, name: 'Acme' }]);
    const res = response();
    await handler(get({ id: CUSTOMER }), res);
    expect(status(res)).toBe(200);
    expect(body(res).data).toEqual({ id: CUSTOMER, name: 'Acme' });
    expect(mocks.listCustomers).not.toHaveBeenCalled();
    // The tenant scope is a bound value of the query itself: the id AND this company's id, nothing else.
    const bound = (mocks.sql.mock.calls[0] as unknown[]).slice(1);
    expect(bound).toEqual([CUSTOMER, COMPANY]);
  });

  it('answers 404 for a customer that is missing or another company\'s (the query is scoped by company_id)', async () => {
    mocks.sql.mockResolvedValueOnce([]);
    const res = response();
    await handler(get({ id: CUSTOMER }), res);
    expect(status(res)).toBe(404);
  });

  it('keeps the legacy answer (the list) for an id that is not a UUID, without touching sql', async () => {
    const res = response();
    await handler(get({ id: 'c1' }), res);
    expect(status(res)).toBe(200);
    expect(mocks.listCustomers).toHaveBeenCalledTimes(1);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});

describe('customers GET ?limit=', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.listCustomers.mockResolvedValue([]); });
  const pageOf = () => mocks.listCustomers.mock.calls[0]?.[2];

  it('passes a short page through', async () => {
    await handler(get({ q: 'ac', limit: '20' }), response());
    expect(mocks.listCustomers).toHaveBeenCalledWith(COMPANY, 'ac', { limit: 20, offset: 0 });
  });

  it('defaults to the 200 the route always answered, and caps at 200 (callers send limit=500)', async () => {
    await handler(get({}), response());
    expect(pageOf()).toEqual({ limit: 200, offset: 0 });
    mocks.listCustomers.mockClear();
    await handler(get({ limit: '500' }), response());
    expect(pageOf()).toEqual({ limit: 200, offset: 0 });
  });

  it('ignores a limit that is not a positive number', async () => {
    for (const limit of ['abc', '0', '-5', '']) {
      mocks.listCustomers.mockClear();
      await handler(get({ limit }), response());
      expect(pageOf()).toEqual({ limit: 200, offset: 0 });
    }
  });
});
