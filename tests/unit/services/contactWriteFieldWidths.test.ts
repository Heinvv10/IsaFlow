/**
 * Supplier and customer writes must refuse a value its column cannot hold.
 *
 * Both services sliced every free-text field to 255 — but phone, vat_number
 * and registration_number are VARCHAR(50), and the bank branch code and
 * account type are VARCHAR(20). A 51-character VAT number passed the slice,
 * reached the INSERT, and Postgres raised 22001 ("value too long for type
 * character varying(50)"), which names no column. create_supplier and
 * create_customer surfaced that as a generic database error.
 *
 * Refused as a ContactValidationError instead: the MCP tools and the API
 * routes already turn that into a 400 naming the problem. Only inputs that
 * fail today change behaviour — a value that fits is written as before.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(
    vi.fn().mockResolvedValue([{ id: 'row-1', name: 'Row' }]),
    { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) },
  );
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: vi.fn() };
});

import { sql } from '@/lib/neon';
import { createSupplier, updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import {
  createCustomer,
  updateCustomer,
  ContactValidationError,
} from '@/modules/accounting/services/core/customerWriteService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const ROW_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([{ id: 'row-1', name: 'Row' }]);
});

describe('createSupplier — narrow columns', () => {
  it.each([
    ['vatNumber', 'vat_number', 50],
    ['phone', 'phone', 50],
    ['registrationNumber', 'registration_number', 50],
    ['bankAccountNumber', 'bank_account_number', 50],
    ['bankBranchCode', 'bank_branch_code', 20],
    ['bankAccountType', 'bank_account_type', 20],
    ['bankName', 'bank_name', 100],
    ['category', 'category', 100],
  ] as const)('refuses %s → %s over %i characters, before any SQL', async (key, field, max) => {
    const err = await createSupplier(COMPANY_ID, { name: 'ACME', [key]: '9'.repeat(max + 1) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContactValidationError);
    expect((err as Error).message).toBe(`${field} is ${max + 1} characters; the maximum is ${max}`);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('writes a value of exactly the column width unchanged', async () => {
    await createSupplier(COMPANY_ID, { name: 'ACME', vatNumber: '4'.repeat(50) });
    expect(mockSql.mock.calls[0]!.slice(1)).toContain('4'.repeat(50));
  });

  it('still slices a wide (255) column rather than refusing it', async () => {
    await expect(createSupplier(COMPANY_ID, { name: 'ACME', email: `${'e'.repeat(300)}@x.co` }))
      .resolves.toBeDefined();
  });
});

describe('updateSupplier — narrow columns', () => {
  it('refuses an over-wide vat number before any SQL', async () => {
    await expect(updateSupplier(COMPANY_ID, ROW_ID, { vatNumber: '9'.repeat(51) }))
      .rejects.toThrow('vat_number is 51 characters; the maximum is 50');
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('createCustomer — narrow columns', () => {
  it.each([
    ['vatNumber', 'vat_number', 50],
    ['phone', 'phone', 50],
    ['mobile', 'mobile', 50],
    ['fax', 'fax', 50],
    ['registrationNumber', 'registration_number', 50],
    ['defaultVatType', 'default_vat_type', 50],
    ['defaultPriceList', 'default_price_list', 100],
    ['paymentTermsType', 'payment_terms_type', 30],
    ['statementDistribution', 'statement_distribution', 20],
  ] as const)('refuses %s → %s over %i characters, before any SQL', async (key, field, max) => {
    const err = await createCustomer(COMPANY_ID, { name: 'ACME', [key]: '9'.repeat(max + 1) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContactValidationError);
    expect((err as Error).message).toBe(`${field} is ${max + 1} characters; the maximum is ${max}`);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('updateCustomer — narrow columns', () => {
  it('refuses an over-wide phone before any SQL', async () => {
    await expect(updateCustomer(COMPANY_ID, ROW_ID, { phone: '0'.repeat(51) }))
      .rejects.toThrow('phone is 51 characters; the maximum is 50');
    expect(mockSql).not.toHaveBeenCalled();
  });
});
