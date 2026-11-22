/**
 * Per-line VAT on quotes (migration 1024): createQuote / updateQuote type every line as a customer invoice does
 * (invoiceLineVatTypes, priced by invoiceLineVatPricing). A line names its `vatType`; the rate comes from the type and
 * the quote date. The legacy per-line `taxRate` (what the quote form sends today) reads as the invoice's legacy header
 * rate: the standard rate -> standard, 0 -> zero_rated, anything else refused; never with a `vatType`. A company not
 * registered for VAT writes untyped lines with no VAT. VAT is rounded on the line; the header is the sum of its lines.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', () => ({ assertLineAccountIds: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ assertCustomerInCompany: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/documentNumberRetry', () => ({
  insertWithReservedNumber: vi.fn(async (_c: string, _t: string, _s: string, _k: unknown, fn: (n: string) => unknown) => fn('QUO0000001')),
}));
vi.mock('@/modules/accounting/services/ar/sourceContentEditor', () => ({
  withSourceEditorStamp: (_c: string, _s: unknown, _e: string, edit: () => Promise<unknown>) => edit(),
}));
vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(), { transaction: vi.fn() }),
  withTransaction: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));

import { LineValidationError } from '@/modules/accounting/services/ar/quoteService';
import { InvoiceLineVatRefusal, InvoiceVatNotRegisteredRefusal } from '@/modules/accounting/services/ar/invoiceLineVatTypes';
import {
  CLIENT_ID, ITEM_ID, create, head, inserted, lineVat, mockSql, resetWorld, world, wrote,
} from './helpers/quoteVatWorld';

beforeEach(resetWorld);

describe('createQuote: per-line VAT types', () => {
  it('a mixed quote stores each line net, its VAT, its type and rate; the header sums the lines, rate = the highest', async () => {
    await create([
      { description: 'A', quantity: 1, unitPrice: 100, vatType: 'standard' },
      { description: 'B', quantity: 1, unitPrice: 50, vatType: 'zero_rated' },
      { description: 'C', quantity: 1, unitPrice: 30, vatType: 'exempt' },
    ]);
    expect(lineVat(inserted('customer_quote_lines'))).toEqual([
      { vat: 'standard', tax: 15, rate: 15, amount: 100 },
      { vat: 'zero_rated', tax: 0, rate: 0, amount: 50 },
      { vat: 'exempt', tax: 0, rate: 0, amount: 30 },
    ]);
    expect(head()).toEqual({ subtotal: 180, tax: 15, total: 195, rate: 15, mode: 'exclusive' });
  });

  it('inclusive: the unit price is stored as entered, the line amount is the net and the VAT is backed out', async () => {
    await create([{ description: 'A', quantity: 1, unitPrice: 115, vatType: 'standard' }], { amountsAre: 'inclusive' });
    const [line] = inserted('customer_quote_lines');
    expect({ price: line!.unit_price, ...lineVat([line!])[0] }).toEqual({ price: 115, vat: 'standard', tax: 15, rate: 15, amount: 100 });
    expect(head()).toEqual({ subtotal: 100, tax: 15, total: 115, rate: 15, mode: 'inclusive' });
  });

  it('VAT is rounded on each line and the header is their sum (seven lines of 14.29: 14.98, not 15.00)', async () => {
    await create(Array.from({ length: 7 }, (_, i) => ({ description: `L${i}`, quantity: 1, unitPrice: 14.29, vatType: 'standard' })));
    expect(head()).toEqual({ subtotal: 100.03, tax: 14.98, total: 115.01, rate: 15, mode: 'exclusive' });
  });

  it('reads the rate by the quote date (a 2018-03-31 standard line is 14%)', async () => {
    await create([{ description: 'A', quantity: 1, unitPrice: 100, vatType: 'standard' }], { quoteDate: '2018-03-31' });
    expect(lineVat(inserted('customer_quote_lines'))).toEqual([{ vat: 'standard', tax: 14, rate: 14, amount: 100 }]);
  });

  it('a line with no type takes the default chain: the customer\'s zero-rated / exempt default, else the item\'s, else standard', async () => {
    world.itemVat = 'zero';
    await create([
      { description: 'Item line', quantity: 1, unitPrice: 10, itemId: ITEM_ID },
      { description: 'Plain', quantity: 1, unitPrice: 10 },
    ]);
    expect(inserted('customer_quote_lines').map((l) => l.vat_type)).toEqual(['zero_rated', 'standard']);
    mockSql.mockClear();
    world.customerVat = 'exempt';
    await create([{ description: 'Plain', quantity: 1, unitPrice: 10 }], { clientId: CLIENT_ID });
    expect(inserted('customer_quote_lines').map((l) => l.vat_type)).toEqual(['exempt']);
  });

  it('a line naming a catalogue item and its vatType gets no taxRate from the item (no vatType + taxRate conflict)', async () => {
    world.itemVat = 'zero';
    await create([{ description: 'Item line', quantity: 1, unitPrice: 10, itemId: ITEM_ID, vatType: 'standard' }]);
    expect(inserted('customer_quote_lines').map((l) => [l.vat_type, l.tax_rate])).toEqual([['standard', 15]]);
  });

  it('the legacy per-line taxRate: the standard rate is standard, 0 is zero_rated (what the quote form sends)', async () => {
    await create([
      { description: 'A', quantity: 2, unitPrice: 100, taxRate: 15 },
      { description: 'B', quantity: 1, unitPrice: 50, taxRate: 0 },
    ]);
    expect(lineVat(inserted('customer_quote_lines'))).toEqual([
      { vat: 'standard', tax: 30, rate: 15, amount: 200 },
      { vat: 'zero_rated', tax: 0, rate: 0, amount: 50 },
    ]);
    expect(head()).toEqual({ subtotal: 250, tax: 30, total: 280, rate: 15, mode: 'exclusive' });
  });

  it('refuses a legacy taxRate that is neither the standard rate nor 0, before any write', async () => {
    await expect(create([{ description: 'A', quantity: 1, unitPrice: 100, taxRate: 14 }])).rejects.toThrow(InvoiceLineVatRefusal);
    expect(wrote()).toBe(false);
  });

  it('refuses a vatType and a taxRate on the same quote (on one line or across lines), before any write', async () => {
    await expect(create([{ description: 'A', quantity: 1, unitPrice: 100, vatType: 'standard', taxRate: 15 }]))
      .rejects.toThrow(/vatType .*or .*taxRate, not both/);
    await expect(create([{ description: 'A', quantity: 1, unitPrice: 100, vatType: 'standard' }, { description: 'B', quantity: 1, unitPrice: 1, taxRate: 0 }]))
      .rejects.toThrow(InvoiceLineVatRefusal);
    expect(wrote()).toBe(false);
  });

  it('refuses a type a quote line does not take, naming the line and the quote', async () => {
    await expect(create([{ description: 'A', quantity: 1, unitPrice: 1, vatType: 'standard' }, { description: 'B', quantity: 1, unitPrice: 1, vatType: 'export' }]))
      .rejects.toThrow('items[1] cannot be export: a quote line is standard, zero_rated or exempt');
    expect(wrote()).toBe(false);
  });

  it('refuses what an invoice of it could not approve (1 x R0.03 standard: the VAT rounds to nothing)', async () => {
    await expect(create([{ description: 'A', quantity: 1, unitPrice: 0.03, vatType: 'standard' }])).rejects.toThrow(InvoiceLineVatRefusal);
    expect(wrote()).toBe(false);
  });

  it('refuses a quantity that stores as 0 (0.004), as an invoice does', async () => {
    await expect(create([{ description: 'A', quantity: 0.004, unitPrice: 100 }])).rejects.toThrow(new LineValidationError('Line 1: quantity must be at least 0.01'));
    expect(wrote()).toBe(false);
  });

  it('refuses an amountsAre that is not exclusive or inclusive, and a total past numeric(15,2)', async () => {
    await expect(create([{ description: 'A', quantity: 1, unitPrice: 1 }], { amountsAre: 'gross' })).rejects.toThrow(LineValidationError);
    await expect(create([{ description: 'A', quantity: 9_999_999, unitPrice: 9_999_999_999 }])).rejects.toThrow(LineValidationError);
    expect(wrote()).toBe(false);
  });
});

describe('createQuote: a company not registered for VAT', () => {
  beforeEach(() => { world.vatPeriod = 'none'; });

  it('writes untyped lines with no VAT, header rate 0 and exclusive whatever was asked', async () => {
    await create([{ description: 'A', quantity: 2, unitPrice: 100 }, { description: 'B', quantity: 1, unitPrice: 5, vatType: 'exempt' }], { amountsAre: 'inclusive' });
    expect(lineVat(inserted('customer_quote_lines'))).toEqual([
      { vat: null, tax: null, rate: 0, amount: 200 },
      { vat: null, tax: null, rate: 0, amount: 5 },
    ]);
    expect(head()).toEqual({ subtotal: 205, tax: 0, total: 205, rate: 0, mode: 'exclusive' });
  });

  it('refuses a standard line or a rate above 0, before any write', async () => {
    await expect(create([{ description: 'A', quantity: 1, unitPrice: 1, vatType: 'standard' }])).rejects.toThrow(InvoiceVatNotRegisteredRefusal);
    await expect(create([{ description: 'A', quantity: 1, unitPrice: 1, taxRate: 15 }])).rejects.toThrow(InvoiceVatNotRegisteredRefusal);
    expect(wrote()).toBe(false);
  });

  it('accepts the legacy taxRate 0 the form sends for it', async () => {
    await create([{ description: 'A', quantity: 1, unitPrice: 100, taxRate: 0 }]);
    expect(lineVat(inserted('customer_quote_lines'))).toEqual([{ vat: null, tax: null, rate: 0, amount: 100 }]);
  });
});
