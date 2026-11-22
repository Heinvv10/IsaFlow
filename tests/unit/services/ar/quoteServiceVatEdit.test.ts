/**
 * Per-line VAT on quotes, the EDIT (updateQuote; split from quoteServiceVat.test.ts at the 300-line cap): a line keeps
 * its stored type by id or a positional resend (quoteEditLines), a legacy quote left as it is keeps its figures, the
 * stored mode stands when none is sent, and an edit whose lines' saved types cannot be read is refused before any write.
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

import { updateQuote } from '@/modules/accounting/services/ar/quoteService';
import { InvoiceLineVatRefusal } from '@/modules/accounting/services/ar/invoiceLineVatTypes';
import {
  CLIENT_ID, COMPANY_ID, ITEM_B, ITEM_ID, QUOTE_ID, inserted, lineVat, mockSql, resetWorld, updatedHeader, world, wrote,
} from './helpers/quoteVatWorld';

beforeEach(resetWorld);

describe('updateQuote: per-line VAT', () => {
  const storedLine = (o: Record<string, unknown>) => ({ id: 'l1', quote_id: QUOTE_ID, sort_order: 1, quantity: '1.00', gl_account_id: null, item_id: null, ...o });

  it('a stored line keeps its type: identical (an exempt line; a legacy 0% line reads zero_rated) or edited in place (its price changed)', async () => {
    world.stored = [
      storedLine({ description: 'Exempt', unit_price: '10.00', amount: '10.00', tax_rate: '0', vat_type: 'exempt', tax_amount: '0' }),
      storedLine({ description: 'Legacy zero', unit_price: '20.00', amount: '20.00', tax_rate: '0', vat_type: null, tax_amount: null }),
      storedLine({ description: 'Old', unit_price: '30.00', amount: '30.00', tax_rate: '0', vat_type: 'zero_rated', tax_amount: '0' }),
    ];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [
      { description: 'Exempt', quantity: 1, unitPrice: 10 },
      { description: 'Legacy zero', quantity: 1, unitPrice: 20 },
      { description: 'Old', quantity: 1, unitPrice: 31 },
    ] }, 'u1');
    expect(inserted('customer_quote_lines').map((l) => [l.vat_type, l.tax_amount])).toEqual([['exempt', 0], ['zero_rated', 0], ['zero_rated', 0]]);
    expect(updatedHeader()).toMatchObject({ subtotal: 61, tax_amount: 0, total: 61, tax_rate: 0, amounts_are: 'exclusive' });
  });

  it('a legacy taxRate 0 resent on an exempt line keeps it exempt (a type of that rate)', async () => {
    world.stored = [storedLine({ description: 'Exempt', unit_price: '10.00', amount: '10.00', tax_rate: '0', vat_type: 'exempt', tax_amount: '0' })];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ description: 'Exempt', quantity: 1, unitPrice: 10, taxRate: 0 }] }, 'u1');
    expect(inserted('customer_quote_lines').map((l) => l.vat_type)).toEqual(['exempt']);
  });

  it('an edit that names no amountsAre keeps the stored inclusive mode (115 incl stays 115, not 132.25)', async () => {
    world.head = { amounts_are: 'inclusive', subtotal: '100', tax_amount: '15', total: '115', tax_rate: '15' };
    world.stored = [storedLine({ description: 'A', unit_price: '115.00', amount: '100.00', tax_rate: '15', vat_type: 'standard', tax_amount: '15' })];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', notes: 'n', lines: [{ description: 'A', quantity: 1, unitPrice: 115 }] }, 'u1');
    expect(updatedHeader()).toMatchObject({ subtotal: 100, tax_amount: 15, total: 115, amounts_are: 'inclusive' });
  });

  it('a LEGACY 14% quote edited without touching its lines keeps them and its figures as stored', async () => {
    world.head = { amounts_are: null, subtotal: '100', tax_amount: '14', total: '114', tax_rate: '14' };
    world.stored = [storedLine({ description: 'Old', unit_price: '100.00', amount: '100.00', tax_rate: '14', vat_type: null, tax_amount: null })];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', notes: 'only notes', lines: [{ description: 'Old', quantity: 1, unitPrice: 100, taxRate: 14 }] }, 'u1');
    expect(lineVat(inserted('customer_quote_lines'))).toEqual([{ vat: null, tax: null, rate: 14, amount: 100 }]);
    expect(updatedHeader()).toMatchObject({ subtotal: 100, tax_amount: 14, total: 114, tax_rate: 14, amounts_are: null });
  });

  it('a legacy taxRate 0 on a stored EXEMPT line whose price changed keeps it exempt', async () => {
    world.stored = [storedLine({ description: 'Rent', unit_price: '10.00', amount: '10.00', tax_rate: '0', vat_type: 'exempt', tax_amount: '0' })];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ description: 'Rent', quantity: 1, unitPrice: 12, taxRate: 0 }] }, 'u1');
    expect(inserted('customer_quote_lines').map((l) => [l.vat_type, l.amount])).toEqual([['exempt', 12]]);
  });

  it('twins standard and exempt resent unchanged in their places (notes only) save, each keeping its type', async () => {
    world.stored = [
      storedLine({ id: 'w1', description: 'Widget', unit_price: '100.00', amount: '100.00', tax_rate: '15', vat_type: 'standard', tax_amount: '15' }),
      storedLine({ id: 'w2', sort_order: 2, description: 'Widget', unit_price: '100.00', amount: '100.00', tax_rate: '0', vat_type: 'exempt', tax_amount: '0' }),
    ];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', notes: 'n', lines: [
      { description: 'Widget', quantity: 1, unitPrice: 100 }, { description: 'Widget', quantity: 1, unitPrice: 100 },
    ] }, 'u1');
    expect(inserted('customer_quote_lines').map((l) => l.vat_type)).toEqual(['standard', 'exempt']);
  });

  it('a company not registered for VAT is never asked for a type: its renamed legacy 0% line saves untyped', async () => {
    world.vatPeriod = 'none';
    world.stored = [storedLine({ description: 'Fee', unit_price: '50.00', amount: '50.00', tax_rate: '0', vat_type: null, tax_amount: null })];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ description: 'Fee (Nov)', quantity: 1, unitPrice: 60 }] }, 'u1');
    expect(inserted('customer_quote_lines').map((l) => [l.vat_type, l.amount])).toEqual([[null, 60]]);
  });

  it('a standard-only quote: a new line takes the default chain (the customer\'s exempt), a kept one its type', async () => {
    world.customerVat = 'exempt';
    world.stored = [storedLine({ description: 'Rent', unit_price: '10.00', amount: '10.00', tax_rate: '15', vat_type: 'standard', tax_amount: '1.5' })];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', clientId: CLIENT_ID, lines: [
      { description: 'Rent', quantity: 1, unitPrice: 10 }, { description: 'New', quantity: 1, unitPrice: 31 },
    ] }, 'u1');
    expect(inserted('customer_quote_lines').map((l) => l.vat_type)).toEqual(['standard', 'exempt']);
  });

  const twins = () => [
    storedLine({ id: 'w1', description: 'Widget', unit_price: '100.00', amount: '100.00', tax_rate: '15', vat_type: 'standard', tax_amount: '15' }),
    storedLine({ id: 'w2', sort_order: 2, description: 'Widget', unit_price: '100.00', amount: '100.00', tax_rate: '0', vat_type: 'exempt', tax_amount: '0' }),
  ];
  it('a quote with an exempt line edited other than in place (a line deleted, a line added, two changed) refuses every typeless line, nothing written', async () => {
    world.stored = twins();
    const edit = (lines: Record<string, unknown>[]) => updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines } as never, 'u1');
    await expect(edit([{ description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 0 }])).rejects.toThrow(/does not resend them in their places/);
    await expect(edit([{ description: 'Widget', quantity: 1, unitPrice: 100 }, { description: 'Widget', quantity: 1, unitPrice: 100 }, { description: 'New', quantity: 1, unitPrice: 5 }]))
      .rejects.toThrow(InvoiceLineVatRefusal);
    await expect(edit([{ description: 'Widget', quantity: 1, unitPrice: 101 }, { description: 'Widget', quantity: 1, unitPrice: 102 }])).rejects.toThrow(InvoiceLineVatRefusal);
    expect(wrote()).toBe(false);
  });

  it('the same edits naming each line\'s vatType (as the quote modal does) or id save', async () => {
    world.stored = twins();
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [
      { id: 'w2', description: 'Widget', quantity: 1, unitPrice: 100 }, { description: 'New', quantity: 1, unitPrice: 5, vatType: 'standard' },
    ] } as never, 'u1');
    expect(inserted('customer_quote_lines').map((l) => l.vat_type)).toEqual(['exempt', 'standard']);
  });

  it('M2: matched on the lines as SENT, not after the item inheritance (twins of items A and B, the first re-priced)', async () => {
    world.stored = [
      storedLine({ id: 'w1', description: 'Widget', unit_price: '100.00', amount: '100.00', tax_rate: '15', vat_type: 'standard', tax_amount: '15', item_id: ITEM_ID }),
      storedLine({ id: 'w2', sort_order: 2, description: 'Widget', unit_price: '100.00', amount: '100.00', tax_rate: '0', vat_type: 'exempt', tax_amount: '0', item_id: ITEM_B }),
    ];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [
      { description: 'Widget', quantity: 1, unitPrice: 110 }, { description: 'Widget', quantity: 1, unitPrice: 100 },
    ] }, 'u1');
    expect(inserted('customer_quote_lines').map((l) => l.vat_type)).toEqual(['standard', 'exempt']);
  });

  it('a registered company\'s legacy 0% line re-priced in place keeps zero-rated; renamed (no item to tell it by) it is refused', async () => {
    world.stored = [storedLine({ description: 'Fee', unit_price: '50.00', amount: '50.00', tax_rate: '0', vat_type: null, tax_amount: null })];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ description: 'Fee', quantity: 1, unitPrice: 60 }] }, 'u1');
    expect(inserted('customer_quote_lines').map((l) => l.vat_type)).toEqual(['zero_rated']);
    mockSql.mockClear();
    await expect(updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ description: 'Fee (Nov)', quantity: 1, unitPrice: 60 }] }, 'u1'))
      .rejects.toThrow(/does not resend them in their places/);
    expect(wrote()).toBe(false);
  });

  it('H1: a legacy quote [A 15%, B 0%] resent identical at rate 15 on both is NOT kept as stored: B becomes standard', async () => {
    world.head = { amounts_are: null, subtotal: '200', tax_amount: '15', total: '215', tax_rate: '15' };
    world.stored = [
      storedLine({ id: 'a', description: 'A', unit_price: '100.00', amount: '100.00', tax_rate: '15', vat_type: null, tax_amount: null }),
      storedLine({ id: 'b', sort_order: 2, description: 'B', unit_price: '100.00', amount: '100.00', tax_rate: '0', vat_type: null, tax_amount: null }),
    ];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [
      { description: 'A', quantity: 1, unitPrice: 100, taxRate: 15 }, { description: 'B', quantity: 1, unitPrice: 100, taxRate: 15 },
    ] }, 'u1');
    expect(lineVat(inserted('customer_quote_lines'))).toEqual([{ vat: 'standard', tax: 15, rate: 15, amount: 100 }, { vat: 'standard', tax: 15, rate: 15, amount: 100 }]);
    expect(updatedHeader()).toMatchObject({ subtotal: 200, tax_amount: 30, total: 230 });
  });

  it('round 6: a legacy line sent BY ID at another rate is re-priced, never kept as stored (15% sent at 0 -> zero-rated; [Export 0%, Local 15%] at 15 -> both standard)', async () => {
    const legacyLine = (id: string, description: string, rate: string, sort = 1) =>
      storedLine({ id, sort_order: sort, description, unit_price: '100.00', amount: '100.00', tax_rate: rate, vat_type: null, tax_amount: null });
    world.head = { amounts_are: null, subtotal: '100', tax_amount: '15', total: '115', tax_rate: '15' };
    world.stored = [legacyLine('a', 'Svc', '15')];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ id: 'a', description: 'Svc', quantity: 1, unitPrice: 100, taxRate: 0 }] } as never, 'u1');
    expect(lineVat(inserted('customer_quote_lines'))).toEqual([{ vat: 'zero_rated', tax: 0, rate: 0, amount: 100 }]);
    mockSql.mockClear();
    world.head = { amounts_are: null, subtotal: '200', tax_amount: '15', total: '215', tax_rate: '15' };
    world.stored = [legacyLine('e', 'Export', '0'), legacyLine('l', 'Local', '15', 2)];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [
      { id: 'E', description: 'Export', quantity: 1, unitPrice: 100, taxRate: 15 }, { id: 'l', description: 'Local', quantity: 1, unitPrice: 100, taxRate: 15 },
    ] } as never, 'u1');
    expect(inserted('customer_quote_lines').map((l) => [l.vat_type, l.tax_amount])).toEqual([['standard', 15], ['standard', 15]]);
    expect(updatedHeader()).toMatchObject({ subtotal: 200, tax_amount: 30, total: 230 });
  });

  it('L2: a taxRate of "" is a clean 400 (not read as 0), nothing written', async () => {
    world.stored = [storedLine({ description: 'Rent', unit_price: '10.00', amount: '10.00', tax_rate: '0', vat_type: 'exempt', tax_amount: '0' })];
    await expect(updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ description: 'Rent', quantity: 1, unitPrice: 10, taxRate: '' }] } as never, 'u1'))
      .rejects.toThrow('Line 1: VAT rate must be a number from 0 to 100');
    expect(wrote()).toBe(false);
  });

  it('L1: a line with no description (a bare API body) is a clean 400 naming the line, nothing written', async () => {
    await expect(updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ quantity: 1, unitPrice: 1 }] } as never, 'u1'))
      .rejects.toThrow('Line 1: description is required');
    expect(wrote()).toBe(false);
  });

  it('refuses before the first write', async () => {
    await expect(updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ description: 'A', quantity: 1, unitPrice: 1, taxRate: 7 }] }, 'u1'))
      .rejects.toThrow(InvoiceLineVatRefusal);
    expect(wrote()).toBe(false);
  });
});
