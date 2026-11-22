/**
 * Per-line VAT on quotes (migration 1024): createQuote / updateQuote type every line as a customer invoice does
 * (invoiceLineVatTypes, priced by invoiceLineVatPricing). A line names its `vatType`; the rate comes from the type and
 * the quote date. The legacy per-line `taxRate` (what the quote form sends today) reads as the invoice's legacy header
 * rate: the standard rate -> standard, 0 -> zero_rated, anything else refused; never with a `vatType`. A company not
 * registered for VAT writes untyped lines with no VAT. VAT is rounded on the line; the header is the sum of its lines.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

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

import { sql } from '@/lib/neon';
import { createQuote, updateQuote, LineValidationError } from '@/modules/accounting/services/ar/quoteService';
import { InvoiceLineVatRefusal, InvoiceVatNotRegisteredRefusal } from '@/modules/accounting/services/ar/invoiceLineVatTypes';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const QUOTE_ID = '22222222-2222-2222-2222-222222222222';
const CLIENT_ID = '33333333-3333-3333-3333-333333333333';
const ITEM_ID = '44444444-4444-4444-4444-444444444444';

const text = (call: unknown[]) => (call[0] as readonly string[]).join('?');
const header = { id: QUOTE_ID, quote_number: 'QUO1', client_id: null, customer_name: 'Acme', quote_date: '2026-11-11', expiry_date: null,
  status: 'draft', subtotal: '0', tax_amount: '0', total: '0', notes: null, terms: null, converted_invoice_id: null, created_at: '', updated_at: '' };

interface World { vatPeriod: string; customerVat: string | null; itemVat: string | null; stored: Record<string, unknown>[]; head: Record<string, unknown> }
let world: World;

function serve() {
  mockSql.mockImplementation(async (...call: unknown[]) => {
    const t = text(call);
    if (t.includes('FROM companies')) return [{ vat_period: world.vatPeriod, vat_system_type: null, customer_vat: world.customerVat }];
    if (t.includes('FROM items')) return [{ id: ITEM_ID, is_active: true, sales_account_id: null, purchases_account_id: null, vat_on_sales: world.itemVat, vat_on_purchases: null }];
    if (t.includes('INSERT INTO customer_quotes')) return [{ id: QUOTE_ID }];
    if (t.includes('FROM customer_quote_lines')) return world.stored;
    if (t.includes('FROM customer_quotes')) return [{ ...header, ...world.head }];
    return [];
  });
}

/** The bound values of an INSERT, by its column list (each VALUES slot is one bound value, in order). */
function inserted(table: string): Record<string, unknown>[] {
  return mockSql.mock.calls.filter((c) => new RegExp(`INSERT INTO ${table}\\s*\\(`).test(text(c))).map((c) => {
    const cols = new RegExp(`INSERT INTO ${table}\\s*\\(([^)]+)\\)`).exec(text(c))![1]!.split(',').map((s) => s.trim());
    return Object.fromEntries(cols.map((col, i) => [col, c[i + 1]]));
  });
}
const updatedHeader = () => {
  const c = mockSql.mock.calls.find((call) => text(call).includes('UPDATE customer_quotes SET'))!;
  const parts = (c[0] as readonly string[]);
  return Object.fromEntries(parts.slice(0, -1).map((p, i) => [/(\w+)\s*=\s*$/.exec(p)?.[1] ?? `?${i}`, c[i + 1]]));
};
const lineVat = (rows: Record<string, unknown>[]) => rows.map((l) => ({ vat: l.vat_type, tax: l.tax_amount, rate: l.tax_rate, amount: l.amount }));
const head = () => { const h = inserted('customer_quotes')[0]!; return { subtotal: h.subtotal, tax: h.tax_amount, total: h.total, rate: h.tax_rate, mode: h.amounts_are }; };
const wrote = () => mockSql.mock.calls.some((c) => /INSERT|UPDATE|DELETE/.test(text(c)));

type Line = { description: string; quantity: number; unitPrice: number; taxRate?: unknown; vatType?: unknown; itemId?: string };
const create = (lines: Line[], extra: Record<string, unknown> = {}) =>
  createQuote(COMPANY_ID, { customerName: 'Acme', quoteDate: '2026-11-11', lines, ...extra } as never, 'u1');

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  world = { vatPeriod: 'bi-monthly', customerVat: null, itemVat: null, stored: [], head: {} };
  serve();
});

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

  it('a line that is new (no stored line at its position or like it) takes the default chain', async () => {
    world.stored = [storedLine({ description: 'Rent', unit_price: '10.00', amount: '10.00', tax_rate: '0', vat_type: 'exempt', tax_amount: '0' })];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [
      { description: 'Rent', quantity: 1, unitPrice: 10 }, { description: 'New', quantity: 1, unitPrice: 31 },
    ] }, 'u1');
    expect(inserted('customer_quote_lines').map((l) => [l.vat_type, l.tax_amount])).toEqual([['exempt', 0], ['standard', 4.65]]);
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

  it('twins "Widget 1 x 100" standard and exempt, the first deleted: the remaining line resent at 0 stays exempt', async () => {
    world.stored = [
      storedLine({ id: 'w1', description: 'Widget', unit_price: '100.00', amount: '100.00', tax_rate: '15', vat_type: 'standard', tax_amount: '15' }),
      storedLine({ id: 'w2', sort_order: 2, description: 'Widget', unit_price: '100.00', amount: '100.00', tax_rate: '0', vat_type: 'exempt', tax_amount: '0' }),
    ];
    await updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 0 }] }, 'u1');
    expect(inserted('customer_quote_lines').map((l) => l.vat_type)).toEqual(['exempt']);
  });

  it('refuses before the first write', async () => {
    await expect(updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines: [{ description: 'A', quantity: 1, unitPrice: 1, taxRate: 7 }] }, 'u1'))
      .rejects.toThrow(InvoiceLineVatRefusal);
    expect(wrote()).toBe(false);
  });
});
