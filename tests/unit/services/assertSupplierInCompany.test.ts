/**
 * R-068 — the tenant fence for a caller-supplied supplier id, the twin of
 * assertCustomerInCompany. The cross-tenant refusal itself is proven against a
 * real database in tests/integration/supplier-ownership-fence-*.int.test.ts;
 * this file pins the contract around it: an absent id passes without a query,
 * the read is savepointed, a malformed id is a refusal and nothing else is.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withSavepoint: vi.fn((_name: string, fn: () => unknown) => Promise.resolve().then(fn)),
  withTransaction: vi.fn(),
}));

import { sql, withSavepoint } from '@/lib/neon';
import {
  assertSupplierInCompany,
  SupplierNotInCompanyError,
} from '@/modules/accounting/services/core/contactDirectoryService';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '33333333-3333-4333-8333-333333333333';

describe('assertSupplierInCompany', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when the supplier belongs to the company, binding both ids', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(assertSupplierInCompany(COMPANY, SUPPLIER)).resolves.toBeUndefined();
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([SUPPLIER, COMPANY]);
  });

  it('refuses a supplier the company does not own, with the typed error', async () => {
    mockSql.mockResolvedValueOnce([]);
    const err = await assertSupplierInCompany(COMPANY, SUPPLIER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierNotInCompanyError);
    expect((err as SupplierNotInCompanyError).code).toBe('SUPPLIER_NOT_FOUND');
  });

  it('does not query at all for an absent supplier id', async () => {
    await expect(assertSupplierInCompany(COMPANY, null)).resolves.toBeUndefined();
    await expect(assertSupplierInCompany(COMPANY, undefined)).resolves.toBeUndefined();
    await expect(assertSupplierInCompany(COMPANY, '')).resolves.toBeUndefined();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('runs the read inside a savepoint whose name fits Postgres identifiers', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    await assertSupplierInCompany(COMPANY, SUPPLIER);
    expect(withSavepoint).toHaveBeenCalledTimes(1);
    const name = vi.mocked(withSavepoint).mock.calls[0]![0] as string;
    expect(name.length).toBeLessThanOrEqual(31);
  });

  it('turns a malformed id (22P02) into the refusal, not an aborted transaction', async () => {
    mockSql.mockRejectedValueOnce(Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }));
    await expect(assertSupplierInCompany(COMPANY, 'not-a-uuid'))
      .rejects.toBeInstanceOf(SupplierNotInCompanyError);
  });

  it('propagates any other database error instead of reporting "not found"', async () => {
    mockSql.mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: '57P01' }));
    await expect(assertSupplierInCompany(COMPANY, SUPPLIER)).rejects.toThrow(/connection terminated/);
  });
});
