/**
 * Customer and supplier writes carry payment terms as a (number, type) pair (migration 958): the legacy forms of the
 * pair are read, a bad pair is refused before any SQL, a create with none stores "not set" (not 30), and an update
 * leaves, sets or clears. What is asserted is the parameters bound to the INSERT / UPDATE.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: vi.fn() };
});
vi.mock('@/modules/accounting/services/ap/supplierPaymentAuthors', () => ({
  bankDetailsChange: vi.fn(() => 'none'), hasBankDetails: vi.fn(() => false),
  lockSupplierBankDetails: vi.fn(async () => null), recordBankDetailsSetter: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { createCustomer, updateCustomer } from '@/modules/accounting/services/core/customerWriteService';
import { ContactValidationError } from '@/modules/accounting/services/core/contactValidationError';
import { createSupplier, updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const ID = 'uuuuuuuu-0000-4000-8000-uuuuuuuuuuuu';

// Parameter positions of the (days, type) pair in each statement, from the column order in the services.
const CUSTOMER_CREATE = { days: 12, type: 13 };
const SUPPLIER_CREATE = { days: 9, type: 10 };
const CUSTOMER_UPDATE = { mode: 21, days: 22, type: 25 };
const SUPPLIER_UPDATE = { mode: 17, days: 18, type: 21 };

const params = (): unknown[] => mockSql.mock.calls[0]!.slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([{ id: ID, name: 'X' }]);
});

describe.each([
  ['customer', (i: object) => createCustomer(COMPANY, { name: 'Acme', ...i }), CUSTOMER_CREATE],
  ['supplier', (i: object) => createSupplier(COMPANY, { name: 'Acme', ...i }, 'user-1'), SUPPLIER_CREATE],
] as const)('create %s', (_who, create, at) => {
  it.each([
    ['a number alone is invoice days', { paymentTerms: 45 }, 45, 'invoice_days'],
    ['Immediate', { paymentTerms: 0, paymentTermsType: 'invoice_days' }, 0, 'invoice_days'],
    ['3 months after statement', { paymentTerms: 3, paymentTermsType: 'statement_months' }, 3, 'statement_months'],
    ['legacy days', { paymentTerms: 30, paymentTermsType: 'days' }, 30, 'invoice_days'],
    ['legacy end_of_month', { paymentTerms: 30, paymentTermsType: 'end_of_month' }, 30, 'statement_days'],
    ['nothing sent is not set, never 30', {}, null, null],
    ['not_set is not set', { paymentTermsType: 'not_set' }, null, null],
  ])('%s', async (_why, input, days, type) => {
    await create(input);
    expect(params()[at.days]).toBe(days);
    expect(params()[at.type]).toBe(type);
  });

  it.each([
    ['an unknown type', { paymentTerms: 30, paymentTermsType: 'net' }],
    ['a type without a number', { paymentTermsType: 'statement_days' }],
    ['a negative number', { paymentTerms: -1 }],
    ['a fractional number', { paymentTerms: 1.5, paymentTermsType: 'invoice_days' }],
    ['not_set with a number', { paymentTerms: 30, paymentTermsType: 'not_set' }],
  ])('refuses %s before any SQL runs', async (_why, input) => {
    await expect(create(input)).rejects.toThrow(ContactValidationError);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe.each([
  ['customer', (i: object) => updateCustomer(COMPANY, ID, i), CUSTOMER_UPDATE],
  ['supplier', (i: object) => updateSupplier(COMPANY, ID, i, 'user-1'), SUPPLIER_UPDATE],
] as const)('update %s', (_who, update, at) => {
  it('leaves the terms when none are sent', async () => {
    await update({ notes: 'x' });
    expect(params()[at.mode]).toBe('leave');
  });

  it('a bare number is days_only: the stored type is kept, not reset to invoice days', async () => {
    await update({ paymentTerms: 60 });
    expect([params()[at.mode], params()[at.days]]).toEqual(['days_only', 60]);
    expect(params()[at.type]).toBeNull();
    const text = (mockSql.mock.calls[0]![0] as unknown as string[]).join('?');
    expect(text).toContain("WHEN 'days_only' THEN COALESCE(NULLIF(payment_terms_type, ''), 'invoice_days')");
  });

  it('sets the pair', async () => {
    await update({ paymentTerms: 60, paymentTermsType: 'statement_days' });
    expect([params()[at.mode], params()[at.days], params()[at.type]]).toEqual(['set', 60, 'statement_days']);
  });

  it('clears the terms on not_set', async () => {
    await update({ paymentTermsType: 'not_set' });
    expect([params()[at.mode], params()[at.days], params()[at.type]]).toEqual(['clear', null, null]);
  });

  it('refuses a bad pair before any SQL runs', async () => {
    await expect(update({ paymentTerms: 30, paymentTermsType: 'net' })).rejects.toThrow(ContactValidationError);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
