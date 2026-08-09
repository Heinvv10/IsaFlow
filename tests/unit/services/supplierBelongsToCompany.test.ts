/**
 * supplierBelongsToCompany — the AP half of the ownership check.
 *
 * There was no supplier equivalent of customerBelongsToCompany, which is why
 * allocate_bank_transaction could book this company's bank money against
 * another tenant's creditor: bankAllocationService resolves the supplier name
 * by id, falls back to `Supplier #<id>` on zero rows, and posts anyway. This
 * mirrors customerBelongsToCompany exactly — same query shape, same tenant
 * scoping, same soft-delete rule.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: vi.fn() };
});

import { sql } from '@/lib/neon';
import {
  customerBelongsToCompany,
  supplierBelongsToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const SUPPLIER_ID = 'ssssssss-0000-4000-8000-ssssssssssss';

function callArgs(): { text: string; params: unknown[] } {
  const call = mockSql.mock.calls[0]!;
  return { text: (call[0] as TemplateStringsArray).join('?'), params: call.slice(1) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([]);
});

describe('supplierBelongsToCompany', () => {
  it('is true when the tenant-scoped lookup returns a row', async () => {
    mockSql.mockResolvedValue([{ '?column?': 1 }]);

    await expect(supplierBelongsToCompany(COMPANY_ID, SUPPLIER_ID)).resolves.toBe(true);
  });

  it('is false for a supplier in another company — zero rows, not an error', async () => {
    mockSql.mockResolvedValue([]);

    await expect(supplierBelongsToCompany(COMPANY_ID, SUPPLIER_ID)).resolves.toBe(false);
  });

  it('filters on company_id and skips soft-deleted suppliers', async () => {
    await supplierBelongsToCompany(COMPANY_ID, SUPPLIER_ID);
    const { text, params } = callArgs();

    expect(text).toMatch(/FROM\s+suppliers/i);
    expect(text).toMatch(/company_id\s*=\s*\?/i);
    expect(text).toMatch(/deleted_at\s+IS\s+NULL/i);
    expect(params).toEqual([SUPPLIER_ID, COMPANY_ID]);
  });

  it('parameterises both ids — no string concatenation into the SQL', async () => {
    await supplierBelongsToCompany(COMPANY_ID, SUPPLIER_ID);
    const { text } = callArgs();

    expect(text).not.toContain(COMPANY_ID);
    expect(text).not.toContain(SUPPLIER_ID);
  });

  it('has the same shape as the customer check it mirrors', async () => {
    await supplierBelongsToCompany(COMPANY_ID, SUPPLIER_ID);
    const supplierText = callArgs().text;

    vi.clearAllMocks();
    await customerBelongsToCompany(COMPANY_ID, 'cust-1');
    const customerText = callArgs().text;

    expect(supplierText.replace(/suppliers/g, 'X')).toBe(customerText.replace(/customers/g, 'X'));
  });
});
