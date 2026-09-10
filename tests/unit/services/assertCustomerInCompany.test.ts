/**
 * R-067 — the tenant fence for a caller-supplied customer id.
 *
 * `customerBelongsToCompany` existed but only the MCP write tools called it;
 * every HTTP route wrote `clientId` straight from the request body into
 * `customer_invoices.client_id` / `customer_id`. `assertCustomerInCompany` is
 * the shared refusal both layers now go through.
 *
 * A guard fails in BOTH directions, so an own-tenant id and an absent id must
 * still pass — several of the columns behind this check are nullable.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = vi.fn();
  return {
    sql: sqlMock,
    withSavepoint: vi.fn((_name: string, fn: () => unknown) => Promise.resolve().then(fn)),
    withTransaction: vi.fn(),
  };
});

import { sql, withSavepoint } from '@/lib/neon';
import {
  assertCustomerInCompany,
  CustomerNotInCompanyError,
} from '@/modules/accounting/services/core/contactDirectoryService';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

describe('assertCustomerInCompany', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when the customer belongs to the company', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(assertCustomerInCompany(COMPANY, CUSTOMER)).resolves.toBeUndefined();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('refuses a customer that belongs to another company', async () => {
    mockSql.mockResolvedValueOnce([]);
    await expect(assertCustomerInCompany(COMPANY, CUSTOMER))
      .rejects.toBeInstanceOf(CustomerNotInCompanyError);
  });

  it('scopes the read by company_id and excludes soft-deleted customers', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    await assertCustomerInCompany(COMPANY, CUSTOMER);
    const text = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(text).toContain('FROM customers');
    expect(text).toContain('company_id');
    expect(text).toContain('deleted_at IS NULL');
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([CUSTOMER, COMPANY]);
  });

  it('does not query at all for an absent customer id', async () => {
    await expect(assertCustomerInCompany(COMPANY, null)).resolves.toBeUndefined();
    await expect(assertCustomerInCompany(COMPANY, undefined)).resolves.toBeUndefined();
    await expect(assertCustomerInCompany(COMPANY, '')).resolves.toBeUndefined();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('runs the read inside a savepoint', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    await assertCustomerInCompany(COMPANY, CUSTOMER);
    expect(withSavepoint).toHaveBeenCalledTimes(1);
    const name = vi.mocked(withSavepoint).mock.calls[0]![0] as string;
    expect(name.length).toBeLessThanOrEqual(31);
  });

  it('turns a malformed id (22P02) into the refusal, not an aborted transaction', async () => {
    mockSql.mockRejectedValueOnce(Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }));
    await expect(assertCustomerInCompany(COMPANY, 'not-a-uuid'))
      .rejects.toBeInstanceOf(CustomerNotInCompanyError);
  });

  it('propagates any other database error instead of reporting "not found"', async () => {
    mockSql.mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: '57P01' }));
    await expect(assertCustomerInCompany(COMPANY, CUSTOMER))
      .rejects.toThrow(/connection terminated/);
  });
});
