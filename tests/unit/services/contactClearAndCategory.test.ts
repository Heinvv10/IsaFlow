/**
 * What an edit may CLEAR, which category a customer may name, and how a request body becomes service input.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn() }), withTransaction: vi.fn(), withSavepoint: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentAuthors', () => ({
  bankDetailsChange: vi.fn(() => 'none'), hasBankDetails: vi.fn(() => false),
  lockSupplierBankDetails: vi.fn(async () => null), recordBankDetailsSetter: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { clearFlags } from '@/modules/accounting/services/core/contactClear';
import { ContactValidationError } from '@/modules/accounting/services/core/contactValidationError';
import { createCustomer, updateCustomer } from '@/modules/accounting/services/core/customerWriteService';
import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import {
  customerInputFromBody, customerPatchFromBody, supplierInputFromBody, supplierPatchFromBody,
} from '@/modules/accounting/services/core/contactRequestInput';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const ID = 'uuuuuuuu-0000-4000-8000-uuuuuuuuuuuu';
const CATEGORY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';

beforeEach(() => { vi.clearAllMocks(); mockSql.mockResolvedValue([{ id: ID, name: 'X' }]); });

describe('clearFlags', () => {
  const allowed = ['email', 'phone'] as const;
  it('flags the named fields and only those', () => {
    expect(clearFlags(['email'], allowed, {})).toEqual({ email: true, phone: false });
    expect(clearFlags(undefined, allowed, {})).toEqual({ email: false, phone: false });
  });
  it('refuses a field that cannot be cleared', () => {
    expect(() => clearFlags(['name'], allowed, {})).toThrow(ContactValidationError);
  });
  it('refuses a field both given a value and cleared, but accepts a blank value', () => {
    expect(() => clearFlags(['email'], allowed, { email: 'a@b.co' })).toThrow('cannot be both set and cleared');
    expect(clearFlags(['email'], allowed, { email: '' })).toEqual({ email: true, phone: false });
  });
});

describe('what an update can clear', () => {
  it.each(['bankAccountNumber', 'bankName', 'bankBranchCode', 'bankAccountType'])('a supplier update cannot clear %s', async (field) => {
    await expect(updateSupplier(COMPANY, ID, { clear: [field] }, 'u')).rejects.toThrow(`${field} cannot be cleared`);
    expect(mockSql).not.toHaveBeenCalled();
  });
  it('neither edit can clear the name', async () => {
    await expect(updateCustomer(COMPANY, ID, { clear: ['name'] })).rejects.toThrow(ContactValidationError);
    await expect(updateSupplier(COMPANY, ID, { clear: ['name'] }, 'u')).rejects.toThrow(ContactValidationError);
  });
});

describe('a customer category must be this company\'s', () => {
  it('refuses a category the company does not have, on create and update, before the write', async () => {
    mockSql.mockResolvedValueOnce([]); // the category lookup finds nothing
    await expect(updateCustomer(COMPANY, ID, { categoryId: CATEGORY })).rejects.toThrow('not one of this company');
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(String((mockSql.mock.calls[0]![0] as string[]).join(''))).toContain('company_id');
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([CATEGORY, COMPANY]);

    mockSql.mockClear();
    mockSql.mockResolvedValueOnce([]);
    await expect(createCustomer(COMPANY, { name: 'A', categoryId: CATEGORY })).rejects.toThrow('not one of this company');
  });
  it('refuses a category that is not a uuid without asking the database', async () => {
    await expect(updateCustomer(COMPANY, ID, { categoryId: 'not-a-uuid' })).rejects.toThrow('customer category id');
    expect(mockSql).not.toHaveBeenCalled();
  });
  it('lets one of the company\'s categories through', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(updateCustomer(COMPANY, ID, { categoryId: CATEGORY })).resolves.toBeDefined();
  });
});

describe('request body to service input', () => {
  it('an edit names the blank and null text fields in clear, and not the ones left out', () => {
    const input = customerPatchFromBody({ id: ID, email: '', phone: null, mobile: '  ', vat_number: 'X1', credit_limit: '' });
    expect([...input.clear!].sort()).toEqual(['creditLimit', 'email', 'mobile', 'phone']);
    expect(input.vatNumber).toBe('X1');
    expect(input.fax).toBeUndefined();
  });
  it('an edit that names an opening balance is refused (create-only); a create keeps it', () => {
    const body = { opening_balance: 100, opening_balance_date: '2026-01-01' };
    expect(() => customerPatchFromBody(body)).toThrow('remove: opening_balance, opening_balance_date');
    expect(() => supplierPatchFromBody({ openingBalance: 1 })).toThrow('remove: openingBalance');
    expect(customerInputFromBody(body).openingBalance).toBe(100);
  });

  it('a number that is not a number is refused, not bound as NaN', () => {
    expect(() => customerInputFromBody({ credit_limit: 'abc' })).toThrow('credit_limit must be a number');
    expect(() => customerInputFromBody({ default_discount: 'NaN' })).toThrow('default_discount must be a number');
    expect(() => supplierInputFromBody({ opening_balance: 'x' })).toThrow('opening_balance must be a number');
    expect(() => customerInputFromBody({ payment_terms: Infinity })).toThrow('payment_terms must be a number');
    expect(customerInputFromBody({ credit_limit: '12.5', default_discount: 0 })).toMatchObject({ creditLimit: 12.5, defaultDiscount: 0 });
  });

  it.each([[null], [undefined], ['text'], [[1]], [5]])('a body of %j is refused before anything is read', (body) => {
    expect(() => customerInputFromBody(body)).toThrow('JSON object');
    expect(() => supplierInputFromBody(body)).toThrow('JSON object');
    expect(() => supplierPatchFromBody(body)).toThrow('JSON object');
  });
  it('a supplier edit body naming a bank field is refused, blank or not', () => {
    expect(() => supplierPatchFromBody({ bank_account_number: '' })).toThrow('remove: bank_account_number');
    expect(() => supplierPatchFromBody({ id: ID, bank_name: null, bankBranchCode: 'x' })).toThrow('bank_name, bankBranchCode');
    expect(supplierPatchFromBody({ id: ID, email: '' }).clear).toEqual(['email']);
  });
});
