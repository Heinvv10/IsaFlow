/**
 * createDraftCustomerInvoice writes per-line VAT (the writer PR): each line's vat_type, tax_amount (its VAT) and
 * tax_rate (its type's rate on the invoice date), amount its NET; the header the sum of its lines, its tax_rate the
 * highest line rate. Every `sql` is answered by its statement text, never by call order. Refusals land before the first
 * write; a company not registered for VAT writes untyped lines with no VAT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  company: { vat_period: 'bi-monthly', vat_system_type: 'invoice', customer_vat: null } as Record<string, unknown>,
  items: [] as Record<string, unknown>[],
  accounts: [] as Record<string, unknown>[],
  header: [] as unknown[],
  lines: [] as unknown[][],
  writes: 0,
}));

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('INSERT INTO customer_invoices (')) { db.writes++; db.header = values; return [{ id: 'inv-1' }]; }
    if (text.includes('INSERT INTO customer_invoice_items')) { db.writes++; db.lines.push(values); return []; }
    if (text.includes('FROM companies co')) return [db.company];
    if (text.includes('FROM items')) return db.items;
    if (text.includes('FROM gl_accounts')) return db.accounts;
    return [];
  }), { transaction: vi.fn(), unsafe: vi.fn((t: string) => t) });
  return { ...actual, sql: sqlMock, withSavepoint: vi.fn(async (_n: string, fn: () => unknown) => fn()) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ assertCustomerInCompany: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/documentNumberRetry', () => ({
  insertWithReservedNumber: vi.fn(async (_c: string, _t: string, _p: string, _u: string, insert: (n: string) => Promise<unknown>) => insert('INV-1')),
}));
vi.mock('@/modules/accounting/services/shared/documentCurrency', () => ({
  resolveDocumentCurrency: async () => ({ currencyCode: 'ZAR', exchangeRate: 1 }),
}));
vi.mock('@/modules/accounting/services/core/paymentTermsResolver', () => ({ dueDateForContact: vi.fn(async () => '2026-12-20') }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionDerivation', () => ({
  deriveRevenueDimensions: vi.fn(async (_c: string, _cl: string, items: unknown[]) => items),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionPolicy', () => ({ assertDocumentDimensions: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', () => ({ invoiceLineCodingRefusal: vi.fn(async () => null) }));

import { createDraftCustomerInvoice, type DraftInvoiceInput } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { InvoiceLineVatRefusal, InvoiceVatNotRegisteredRefusal } from '@/modules/accounting/services/ar/invoiceLineVatTypes';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = '55555555-5555-4555-8555-555555555555';

// customer_invoices VALUES: ... 7 subtotal, 8 tax_rate, 9 tax_amount, 10 total_amount, 11 invoice_date
const header = () => ({ subtotal: db.header[7], taxRate: db.header[8], tax: db.header[9], total: db.header[10] });
// customer_invoice_items VALUES: 0 invoice, 1 description, 2 unit_price, 3 quantity, 4 amount, 5 tax_rate, ... 14 tax_amount, 15 vat_type
const lines = () => db.lines.map((v) => ({ description: v[1], price: v[2], amount: v[4], taxRate: v[5], tax: v[14], vatType: v[15] }));

const create = (over: Partial<DraftInvoiceInput> & { items: DraftInvoiceInput['items'] }) =>
  createDraftCustomerInvoice(COMPANY, USER, { clientId: CLIENT, invoiceDate: '2026-11-20', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  db.company = { vat_period: 'bi-monthly', vat_system_type: 'invoice', customer_vat: null };
  db.items = []; db.accounts = []; db.header = []; db.lines = []; db.writes = 0;
});

describe('typed lines', () => {
  it('1000 standard + 300 zero_rated + 200 exempt: each line its own VAT, the header 1500 / 150 / 1650 at 15', async () => {
    await create({ items: [
      { description: 'Standard', unitPrice: 1000, vatType: 'standard' },
      { description: 'Zero', unitPrice: 300, vatType: 'zero_rated' },
      { description: 'Exempt', unitPrice: 200, vatType: 'exempt' },
    ] });
    expect(lines()).toEqual([
      { description: 'Standard', price: 1000, amount: 1000, taxRate: 15, tax: 150, vatType: 'standard' },
      { description: 'Zero', price: 300, amount: 300, taxRate: 0, tax: 0, vatType: 'zero_rated' },
      { description: 'Exempt', price: 200, amount: 200, taxRate: 0, tax: 0, vatType: 'exempt' },
    ]);
    expect(header()).toEqual({ subtotal: 1500, taxRate: 15, tax: 150, total: 1650 });
  });

  it('an all-exempt invoice stores header tax_rate 0', async () => {
    await create({ items: [{ description: 'Rent', unitPrice: 1000, vatType: 'exempt' }] });
    expect(header()).toEqual({ subtotal: 1000, taxRate: 0, tax: 0, total: 1000 });
  });

  it('seven lines of 14.29 standard: VAT 14.98 (rounded per line), where VAT on the subtotal was 15.00', async () => {
    await create({ taxRate: 15, items: Array.from({ length: 7 }, (_, i) => ({ description: `L${i}`, unitPrice: 14.29 })) });
    expect(header()).toEqual({ subtotal: 100.03, taxRate: 15, tax: 14.98, total: 115.01 });
  });
});

describe('amountsAre', () => {
  // customer_invoices VALUES: ... 22 amounts_are (the last)
  it('inclusive: unit_price stored as entered, amount the NET, VAT backed out per line; the total is what was entered', async () => {
    await create({ amountsAre: 'inclusive', items: [{ description: 'Ten', quantity: 100, unitPrice: 9.99, vatType: 'standard' }] });
    expect(lines()).toEqual([{ description: 'Ten', price: 9.99, amount: 868.7, taxRate: 15, tax: 130.3, vatType: 'standard' }]);
    expect(header()).toEqual({ subtotal: 868.7, taxRate: 15, tax: 130.3, total: 999 });
    expect(db.header[22]).toBe('inclusive');
  });
  it('absent is exclusive, and stored so', async () => {
    await create({ items: [{ description: 'A', unitPrice: 100 }] });
    expect(db.header[22]).toBe('exclusive');
  });
  it('anything else is refused before the first write', async () => {
    await expect(create({ amountsAre: 'gross', items: [{ description: 'A', unitPrice: 100 }] })).rejects.toThrow('amountsAre must be "exclusive" or "inclusive"');
    expect(db.writes).toBe(0);
  });
});

describe('the legacy header taxRate', () => {
  it('15 types every line standard', async () => {
    await create({ taxRate: 15, items: [{ description: 'A', unitPrice: 100 }] });
    expect(lines()[0]).toMatchObject({ vatType: 'standard', tax: 15, taxRate: 15 });
  });
  it('0 types every line zero_rated', async () => {
    await create({ taxRate: 0, items: [{ description: 'A', unitPrice: 100 }] });
    expect(lines()[0]).toMatchObject({ vatType: 'zero_rated', tax: 0, taxRate: 0 });
    expect(header()).toMatchObject({ taxRate: 0, tax: 0 });
  });
  it.each([14, 100])('%s is refused before the first write', async (rate) => {
    await expect(create({ taxRate: rate, items: [{ description: 'A', unitPrice: 100 }] })).rejects.toBeInstanceOf(InvoiceLineVatRefusal);
    expect(db.writes).toBe(0);
  });
  it('a header taxRate with a line vatType is refused before the first write', async () => {
    await expect(create({ taxRate: 15, items: [{ description: 'A', unitPrice: 100, vatType: 'standard' }] }))
      .rejects.toThrow(/not both/);
    expect(db.writes).toBe(0);
  });
});

describe('the default chain reads the customer and the item, never the account', () => {
  it('the customer zero-rated: every line zero_rated', async () => {
    db.company = { ...db.company, customer_vat: 'zero' };
    await create({ items: [{ description: 'A', unitPrice: 100 }] });
    expect(lines()[0]).toMatchObject({ vatType: 'zero_rated', tax: 0 });
  });
  it('the item exempt (its sales account standard) gives exempt', async () => {
    db.items = [{ id: ITEM, is_active: true, sales_account_id: ACCOUNT, purchases_account_id: null, vat_on_sales: 'exempt', vat_on_purchases: null }];
    db.accounts = [{ id: ACCOUNT, is_active: true, default_vat_code: 'standard' }];
    await create({ items: [{ description: 'A', unitPrice: 100, itemId: ITEM }] });
    expect(lines()[0]).toMatchObject({ vatType: 'exempt', tax: 0 });
  });
  it('a line on an account whose default_vat_code is exempt, no type: standard (the account is not read; decided, #1701 round 1)', async () => {
    db.accounts = [{ id: ACCOUNT, is_active: true, default_vat_code: 'exempt' }];
    await create({ items: [{ description: 'A', unitPrice: 100, glAccountId: ACCOUNT }] });
    expect(lines()[0]).toMatchObject({ vatType: 'standard', tax: 15 });
    const sqlCalls = (await import('@/lib/neon')).sql as unknown as { mock: { calls: [readonly string[]][] } };
    expect(sqlCalls.mock.calls.some(([s]) => s.join('?').includes('default_vat_code'))).toBe(false);
  });
  it('nothing says otherwise: standard at the rate on the invoice date (14% on 2018-03-31)', async () => {
    await create({ invoiceDate: '2018-03-31', items: [{ description: 'A', unitPrice: 100 }] });
    expect(lines()[0]).toMatchObject({ vatType: 'standard', tax: 14, taxRate: 14 });
    expect(header()).toMatchObject({ taxRate: 14, tax: 14, total: 114 });
  });
});

describe('a company not registered for VAT', () => {
  beforeEach(() => { db.company = { vat_period: 'none', vat_system_type: 'none', customer_vat: null }; });

  it('writes untyped lines with no VAT, header rate 0', async () => {
    await create({ items: [{ description: 'A', unitPrice: 100 }, { description: 'B', unitPrice: 50, vatType: 'exempt' }] });
    expect(lines()).toEqual([
      { description: 'A', price: 100, amount: 100, taxRate: 0, tax: null, vatType: null },
      { description: 'B', price: 50, amount: 50, taxRate: 0, tax: null, vatType: null },
    ]);
    expect(header()).toEqual({ subtotal: 150, taxRate: 0, tax: 0, total: 150 });
  });
  it.each([
    ['a standard line', { items: [{ description: 'A', unitPrice: 100, vatType: 'standard' }] }],
    ['a header rate of 15', { taxRate: 15, items: [{ description: 'A', unitPrice: 100 }] }],
  ])('refuses %s before the first write', async (_l, over) => {
    await expect(create(over as Parameters<typeof create>[0])).rejects.toBeInstanceOf(InvoiceVatNotRegisteredRefusal);
    expect(db.writes).toBe(0);
  });
});

describe('#1701 round 1', () => {
  it('writer / poster parity: 1 x R0.03 standard (VAT rounds to nothing) is refused before the first write', async () => {
    const err = await create({ items: [{ description: 'Tiny', unitPrice: 0.03, vatType: 'standard' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineVatRefusal);
    expect((err as Error).message).toMatch(/^This invoice could not be approved as priced: its standard lines come to 0\.03 but the VAT on them rounds to nothing/);
    expect(db.writes).toBe(0);
  });

  it('a company not registered for VAT stores amounts_are exclusive whatever was asked', async () => {
    db.company = { vat_period: 'none', vat_system_type: 'none', customer_vat: null };
    await create({ amountsAre: 'inclusive', items: [{ description: 'A', unitPrice: 115 }] });
    expect(db.header[22]).toBe('exclusive');
    expect(header()).toEqual({ subtotal: 115, taxRate: 0, tax: 0, total: 115 });
  });

  it.each([
    ['1993-04-06', 10], ['1993-04-07', 14], ['2018-03-31', 14], ['2018-04-01', 15],
  ])('a standard line on %s carries %s%%', async (invoiceDate, rate) => {
    await create({ invoiceDate, items: [{ description: 'A', unitPrice: 100, vatType: 'standard' }] });
    expect(lines()[0]).toMatchObject({ taxRate: rate, tax: rate });
  });

  it('a date before VAT began (1991-09-30) is refused before the first write', async () => {
    await expect(create({ invoiceDate: '1991-09-29', items: [{ description: 'A', unitPrice: 100 }] }))
      .rejects.toThrow('The invoice date has no VAT rate: 1991-09-29 is before VAT began (1991-09-30)');
    expect(db.writes).toBe(0);
  });

  it('an exact half cent of VAT rounds away from zero: 0.10 standard carries 0.02', async () => {
    await create({ items: [{ description: 'A', unitPrice: 0.1, quantity: 1, vatType: 'standard' }, { description: 'B', unitPrice: 100 }] });
    expect(lines()[0]).toMatchObject({ amount: 0.1, tax: 0.02 });
  });
});
