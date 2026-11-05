/**
 * createDraftCustomerInvoice fills a missing due date from the customer's payment terms (migration 958) and keeps a
 * date the caller named. What is asserted is the due date bound to the customer_invoices INSERT, and that the terms are
 * read inside the company.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  terms: [] as Array<Record<string, unknown>>,
  insert: [] as unknown[],
  termsLookup: [] as unknown[],
}));

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('LEFT JOIN customers')) { state.termsLookup = values; return state.terms; }
    if (text.includes('INSERT INTO customer_invoices')) { state.insert = values; return [{ id: 'inv-1' }]; }
    return [];
  }), { transaction: vi.fn(), unsafe: vi.fn((t: string) => t) });
  return { ...actual, sql: sqlMock, withSavepoint: vi.fn(async (_n: string, fn: () => unknown) => fn()) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ assertCustomerInCompany: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/documentNumberRetry', () => ({
  insertWithReservedNumber: vi.fn(async (_c: string, _t: string, _p: string, _u: string, insert: (n: string) => Promise<{ invoiceId: string; invoiceNumber: string }>) => insert('INV-1')),
}));
vi.mock('@/modules/accounting/services/shared/documentCurrency', () => ({
  resolveDocumentCurrency: async () => ({ currencyCode: 'ZAR', exchangeRate: 1 }),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionDerivation', () => ({
  deriveRevenueDimensions: vi.fn(async (_c: string, _cl: string, items: unknown[]) => items),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionPolicy', () => ({ assertDocumentDimensions: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', () => ({ invoiceLineCodingRefusal: vi.fn(async () => null) }));

import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
// INSERT customer_invoices values: company, number, project, customer, client, bpStart, bpEnd, subtotal, rate, tax, total, invoice_date, due_date
const DUE_DATE_INDEX = 12;

const draft = (dueDate?: string) => createDraftCustomerInvoice(COMPANY, USER, {
  clientId: CLIENT, invoiceDate: '2026-08-16', ...(dueDate ? { dueDate } : {}),
  items: [{ description: 'Consulting', unitPrice: 1000, quantity: 1 }],
});

beforeEach(() => { vi.clearAllMocks(); state.terms = []; state.insert = []; state.termsLookup = []; });

describe('createDraftCustomerInvoice due date', () => {
  it.each([
    ['3 months after statement', 3, 'statement_months', '2026-11-30'],
    ['30 days after statement', 30, 'statement_days', '2026-09-30'],
    ['Immediate', 0, 'invoice_days', '2026-08-16'],
    ['60 days from invoice', 60, 'invoice_days', '2026-10-15'],
    ['legacy end_of_month', 0, 'end_of_month', '2026-08-31'],
  ])('no due date named: %s', async (_why, days, type, due) => {
    state.terms = [{ payment_terms: days, payment_terms_type: type }];
    await draft();
    expect(state.insert[DUE_DATE_INDEX]).toBe(due);
    // The customer and the company, then the company again for its default-terms setting.
    expect(state.termsLookup).toEqual([CLIENT, COMPANY, COMPANY, 'default_payment_terms']);
  });

  it('terms not set use the company default (30 days from invoice unless the company says otherwise)', async () => {
    state.terms = [{ payment_terms: null, payment_terms_type: null }];
    await draft();
    expect(state.insert[DUE_DATE_INDEX]).toBe('2026-09-15');
    state.terms = [{ payment_terms: null, payment_terms_type: null, company_default_terms: JSON.stringify({ days: 1, type: 'statement_months' }) }];
    await draft();
    expect(state.insert[DUE_DATE_INDEX]).toBe('2026-09-30');
  });

  it('reads the legacy shapes: days, and a number with no type', async () => {
    state.terms = [{ payment_terms: 14, payment_terms_type: 'days' }];
    await draft();
    expect(state.insert[DUE_DATE_INDEX]).toBe('2026-08-30');
    state.terms = [{ payment_terms: 14, payment_terms_type: null }];
    await draft();
    expect(state.insert[DUE_DATE_INDEX]).toBe('2026-08-30');
  });

  it('a due date the caller names is kept and the terms are not read', async () => {
    state.terms = [{ payment_terms: 3, payment_terms_type: 'statement_months' }];
    await draft('2026-09-01');
    expect(state.insert[DUE_DATE_INDEX]).toBe('2026-09-01');
    expect(state.termsLookup).toEqual([]);
  });
});
