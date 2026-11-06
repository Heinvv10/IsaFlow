/**
 * createSupplierInvoice stores the due date the supplier's terms give (migration 960) when the caller names none,
 * falling back to the invoice's own "netNN" text, and never overriding a date the caller supplied. The assertion is on
 * the value bound to the INSERT, not on a row the mock hands back.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) });
  return { sql: sqlMock, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});
vi.mock('@/modules/accounting/services/shared/documentCurrency', () => ({
  resolveDocumentCurrency: async () => ({ currencyCode: 'ZAR', exchangeRate: 1 }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ assertSupplierInCompany: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/ap/billLineAccountGuard', () => ({ assertBillLineAccounts: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/gl/dimensions/supplierDimensionDefaults', () => ({
  resolveBillLineDimensions: vi.fn(async (_c: string, _s: string, lines: unknown[]) => [...lines]),
}));
vi.mock('@/modules/accounting/services/journalEntryService', () => ({ createJournalEntry: vi.fn(), postJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/systemAccountResolver', () => ({ getSystemAccount: vi.fn(), getSystemAccountId: vi.fn() }));
vi.mock('@/modules/accounting/utils/threeWayMatch', () => ({ validateThreeWayMatch: vi.fn() }));

import { sql, withTransaction } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import type { SupplierInvoiceCreateInput } from '@/modules/accounting/types/ap.types';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockTx = withTransaction as unknown as MockedFunction<(fn: (tx: typeof sql) => Promise<unknown>) => Promise<unknown>>;

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const SUPPLIER_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ROW = { id: 'sinv-1', invoice_number: 'INV-1', supplier_id: SUPPLIER_ID, invoice_date: '2026-08-16', total_amount: '115.00',
  subtotal: '100.00', tax_rate: '15', tax_amount: '15.00', amount_paid: '0', balance: '115.00', status: 'draft', created_at: '2026-08-16' };
// INSERT supplier_invoices values: company, number, supplier, po, grn, invoice_date, due_date, ...
const DUE_DATE_INDEX = 6;

function input(over: Partial<SupplierInvoiceCreateInput>): SupplierInvoiceCreateInput {
  return {
    invoiceNumber: 'INV-1', supplierId: SUPPLIER_ID, invoiceDate: '2026-08-16', taxRate: 15,
    items: [{ description: 'Cable', quantity: 1, unitPrice: 100, taxRate: 15 }], ...over,
  };
}

type SupplierTerms = { payment_terms: number | null; payment_terms_type: string | null };
const NOT_SET: SupplierTerms = { payment_terms: null, payment_terms_type: null };

/** Create a bill for a supplier with these terms (and this company default); returns the due date bound to the INSERT. */
async function storedDueDate(
  supplier: SupplierTerms,
  over: Partial<SupplierInvoiceCreateInput>,
  companyDefault: { company_default_terms: string } | null = null,
): Promise<unknown> {
  mockSql.mockResolvedValueOnce([{ vat_number: '4000123456', ...supplier, ...(companyDefault ?? {}) }]);
  let bound: unknown[] = [];
  mockTx.mockImplementation(async (fn) => {
    const tx = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      if (bound.length === 0) bound = values;
      return [ROW];
    }) as unknown as typeof sql;
    return fn(tx);
  });
  await createSupplierInvoice(COMPANY_ID, input(over), USER_ID);
  return bound[DUE_DATE_INDEX];
}

describe('createSupplierInvoice due date', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('statement_months 3 on a 16 Aug bill is 30 Nov', async () => {
    expect(await storedDueDate({ payment_terms: 3, payment_terms_type: 'statement_months' }, {})).toBe('2026-11-30');
  });

  it('invoice_days 90 on a 16 Sep bill is 15 Dec; statement_days 0 is month-end', async () => {
    expect(await storedDueDate({ payment_terms: 90, payment_terms_type: 'invoice_days' }, { invoiceDate: '2026-09-16' })).toBe('2026-12-15');
    expect(await storedDueDate({ payment_terms: 0, payment_terms_type: 'statement_days' }, { invoiceDate: '2026-09-16' })).toBe('2026-09-30');
  });

  it('Immediate (invoice_days 0) is the invoice date', async () => {
    expect(await storedDueDate({ payment_terms: 0, payment_terms_type: 'invoice_days' }, {})).toBe('2026-08-16');
  });

  it('reads the legacy shapes: days, end_of_month, and a number with no type', async () => {
    expect(await storedDueDate({ payment_terms: 45, payment_terms_type: 'days' }, {})).toBe('2026-09-30');
    expect(await storedDueDate({ payment_terms: 14, payment_terms_type: 'end_of_month' }, {})).toBe('2026-09-14');
    expect(await storedDueDate({ payment_terms: 30, payment_terms_type: null }, {})).toBe('2026-09-15');
  });

  it('precedence: a due date the caller names wins over everything', async () => {
    expect(await storedDueDate({ payment_terms: 3, payment_terms_type: 'statement_months' }, { dueDate: '2026-09-01', paymentTerms: 'net60' })).toBe('2026-09-01');
  });

  it('precedence: the bill\'s own terms, when someone chose them, beat the supplier\'s', async () => {
    expect(await storedDueDate({ payment_terms: 3, payment_terms_type: 'statement_months' }, { paymentTerms: 'net30', invoiceDate: '2026-03-15' })).toBe('2026-04-14');
    expect(await storedDueDate({ payment_terms: 3, payment_terms_type: 'statement_months' }, { paymentTerms: 'immediate' })).toBe('2026-08-16');
  });

  it('precedence: no own terms, supplier terms beat the company default', async () => {
    expect(await storedDueDate({ payment_terms: 3, payment_terms_type: 'statement_months' }, {},
      { company_default_terms: JSON.stringify({ days: 7, type: 'invoice_days' }) })).toBe('2026-11-30');
  });

  it('a supplier whose terms are not set uses the company default (30 days from invoice when it says nothing else)', async () => {
    expect(await storedDueDate(NOT_SET, {})).toBe('2026-09-15');
    expect(await storedDueDate(NOT_SET, { paymentTerms: '' })).toBe('2026-09-15');
    expect(await storedDueDate(NOT_SET, {}, { company_default_terms: JSON.stringify({ days: 2, type: 'statement_months' }) })).toBe('2026-10-31');
  });

  it('terms text that is not netNN or immediate falls through to the supplier / the default', async () => {
    expect(await storedDueDate(NOT_SET, { paymentTerms: 'by arrangement' })).toBe('2026-09-15');
  });
});
