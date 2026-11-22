/**
 * What a quote's invoice carries (quoteInvoiceVat, migration 1024): a typed quote's lines keep their VAT type and are
 * priced at the invoice date by the invoice's own pricing, which on the same rate is the quote's stored figures exactly;
 * a legacy quote is copied as stored, never re-priced; a partly typed one is refused.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { quoteInvoiceVat } from '@/modules/accounting/services/ar/quoteInvoiceVat';
import { InvoiceLineVatRefusal, InvoiceVatNotRegisteredRefusal } from '@/modules/accounting/services/ar/invoiceLineVatTypes';
import type { Quote, QuoteLine } from '@/modules/accounting/services/ar/quoteService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
let vatPeriod = 'bi-monthly';

const line = (o: Partial<QuoteLine>): QuoteLine => ({
  id: 'l', quoteId: 'q', lineNumber: 1, description: 'x', quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100,
  accountId: null, itemId: null, vatType: null, taxAmount: null, ...o,
});
const quote = (lines: QuoteLine[], o: Partial<Quote> = {}): Quote => ({
  id: 'q', quoteNumber: 'QUO1', clientId: null, customerName: 'Acme', quoteDate: '2026-11-11', expiryDate: null, status: 'accepted',
  subtotal: 0, taxAmount: 0, total: 0, taxRate: 15, amountsAre: 'exclusive', notes: null, terms: null, convertedInvoiceId: null,
  createdAt: '', updatedAt: '', lines, ...o,
});
const figures = (v: Awaited<ReturnType<typeof quoteInvoiceVat>>) => ({
  head: [v.subtotal, v.tax, v.total, v.taxRate, v.amountsAre], lines: v.lines.map((l) => [l.vatType, l.price, l.amount, l.taxAmount, l.taxRate]),
});

beforeEach(() => {
  vatPeriod = 'bi-monthly';
  mockSql.mockReset();
  mockSql.mockImplementation(async () => [{ vat_period: vatPeriod, vat_system_type: null, customer_vat: null }]);
});

describe('quoteInvoiceVat, a typed quote', () => {
  it('a mixed exclusive quote: each line\'s type, net and VAT, and the header, equal the quote\'s', async () => {
    const q = quote([
      line({ vatType: 'standard', taxAmount: 15, unitPrice: 100, lineTotal: 100 }),
      line({ vatType: 'zero_rated', taxAmount: 0, unitPrice: 50, lineTotal: 50, taxRate: 0 }),
      line({ vatType: 'exempt', taxAmount: 0, unitPrice: 30, lineTotal: 30, taxRate: 0 }),
    ], { subtotal: 180, taxAmount: 15, total: 195 });
    expect(figures(await quoteInvoiceVat(COMPANY_ID, q, '2026-11-22'))).toEqual({
      head: [180, 15, 195, 15, 'exclusive'],
      lines: [['standard', 100, 100, 15, 15], ['zero_rated', 50, 50, 0, 0], ['exempt', 30, 30, 0, 0]],
    });
  });

  it('an inclusive quote keeps its unit prices as entered and its gross', async () => {
    const q = quote([line({ vatType: 'standard', taxAmount: 15, unitPrice: 115, lineTotal: 100 })],
      { subtotal: 100, taxAmount: 15, total: 115, amountsAre: 'inclusive' });
    expect(figures(await quoteInvoiceVat(COMPANY_ID, q, '2026-11-22'))).toEqual({
      head: [100, 15, 115, 15, 'inclusive'], lines: [['standard', 115, 100, 15, 15]],
    });
  });

  it('invoiced across a change of the standard rate, it charges the rate on the invoice date (net kept)', async () => {
    const q = quote([line({ vatType: 'standard', taxAmount: 14, taxRate: 14 })], { quoteDate: '2018-03-31', subtotal: 100, taxAmount: 14, total: 114 });
    expect(figures(await quoteInvoiceVat(COMPANY_ID, q, '2018-04-01')).head).toEqual([100, 15, 115, 15, 'exclusive']);
  });

  it('a company no longer registered for VAT: a standard line is refused, zero-rated / exempt lines convert untyped', async () => {
    vatPeriod = 'none';
    await expect(quoteInvoiceVat(COMPANY_ID, quote([line({ vatType: 'standard', taxAmount: 15 })]), '2026-11-22'))
      .rejects.toThrow(InvoiceVatNotRegisteredRefusal);
    const q = quote([line({ vatType: 'exempt', taxAmount: 0, taxRate: 0 })], { subtotal: 100, taxAmount: 0, total: 100 });
    expect(figures(await quoteInvoiceVat(COMPANY_ID, q, '2026-11-22'))).toEqual({
      head: [100, 0, 100, 0, 'exclusive'], lines: [[null, 100, 100, null, 0]],
    });
  });
});

describe('quoteInvoiceVat, a legacy quote', () => {
  it('copies the stored figures, never re-priced, untyped, amounts_are null; a uniform rate is the header rate', async () => {
    // A 14% legacy line priced long ago: copied as it is, though no type could be read for it today.
    const q = quote([line({ taxRate: 14, lineTotal: 100 }), line({ taxRate: 14, lineTotal: 50, unitPrice: 50 })],
      { subtotal: 150, taxAmount: 21, total: 171 });
    expect(figures(await quoteInvoiceVat(COMPANY_ID, q, '2026-11-22'))).toEqual({
      head: [150, 21, 171, 14, null], lines: [[null, 100, 100, null, 14], [null, 50, 50, null, 14]],
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('a mixed-rate legacy quote gets the standard header rate, as before', async () => {
    const q = quote([line({ taxRate: 15 }), line({ taxRate: 0 })], { subtotal: 200, taxAmount: 15, total: 215 });
    expect((await quoteInvoiceVat(COMPANY_ID, q, '2026-11-22')).taxRate).toBe(15);
  });

  it('refuses a partly typed quote', async () => {
    await expect(quoteInvoiceVat(COMPANY_ID, quote([line({ vatType: 'standard', taxAmount: 15 }), line({})]), '2026-11-22'))
      .rejects.toThrow(InvoiceLineVatRefusal);
  });
});
