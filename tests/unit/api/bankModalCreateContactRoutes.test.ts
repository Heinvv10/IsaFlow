/**
 * The bank page's create-supplier / create-customer modal posts the bodies built by
 * `createEntity/entityRequests`. These feed that exact body to the real routes and check what reaches the
 * write service: a name the route does not read would reach it as `undefined` and fail validation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ createSupplier: vi.fn(), createCustomer: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/supplierWriteService', () => ({
  createSupplier: mocks.createSupplier, updateSupplier: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/customerWriteService', () => ({
  createCustomer: mocks.createCustomer,
  ContactValidationError: class ContactValidationError extends Error {},
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ listSuppliers: vi.fn(), listCustomers: vi.fn() }));

import suppliersList from '../../../pages/api/accounting/suppliers-list';
import customers from '../../../pages/api/accounting/customers';
import {
  SUPPLIER_CREATE_URL, CUSTOMER_CREATE_URL, supplierCreateBody, customerCreateBody,
} from '@/components/accounting/createEntity/entityRequests';

const COMPANY = '11111111-1111-4111-8111-111111111111';
function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
}
const post = (body: unknown) =>
  ({ method: 'POST', companyId: COMPANY, user: { id: 'u' }, query: {}, body }) as unknown as NextApiRequest;

describe('bank page modal create bodies are accepted by the real routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('points at routes that exist', () => {
    expect(SUPPLIER_CREATE_URL).toBe('/api/accounting/suppliers-list');
    expect(CUSTOMER_CREATE_URL).toBe('/api/accounting/customers');
  });

  it('supplier body reaches createSupplier with name, email and phone', async () => {
    mocks.createSupplier.mockResolvedValueOnce({ id: 's1', name: 'Acme' });
    const res = response();
    await suppliersList(post(supplierCreateBody({ name: ' Acme ', email: 'a@acme.co.za', phone: '012' })), res);
    expect(mocks.createSupplier).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ name: 'Acme', email: 'a@acme.co.za', phone: '012' }));
    expect(vi.mocked(res.status).mock.calls[0]?.[0]).toBe(200);
  });

  it('customer body reaches createCustomer with name, email and phone', async () => {
    mocks.createCustomer.mockResolvedValueOnce({ id: 'c1', name: 'Fibertime' });
    const res = response();
    await customers(post(customerCreateBody({ name: 'Fibertime', email: 'f@x.co.za', phone: '' })), res);
    expect(mocks.createCustomer).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ name: 'Fibertime', email: 'f@x.co.za', phone: undefined }));
    expect(vi.mocked(res.status).mock.calls[0]?.[0]).toBe(200);
  });
});
