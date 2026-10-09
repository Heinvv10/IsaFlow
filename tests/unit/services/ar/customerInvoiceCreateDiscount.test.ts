/**
 * `createDraftCustomerInvoice` dropped each line's `discount`. The new-invoice
 * page shows qty × price × (1 − discount/100) and posts the line's `discount`,
 * but creation stored the undiscounted amount, so the saved invoice billed the
 * client more than the screen showed. The draft edit applied it already.
 *
 * Creation now prices through invoiceLineAmount.ts, as the draft edit and the
 * page previews do — each line rounded to the cent, the subtotal the SUM of
 * the stored line amounts, so the header foots to its own lines. `discount` is
 * validated as the draft edit's zod schema validates it (a number, 0 to 100),
 * and quantity and price must be numbers too, all before the first write.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn((t: string) => t) });
  return { ...actual, sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertCustomerInCompany: vi.fn(),
  CustomerNotInCompanyError: class extends Error {},
}));
vi.mock('@/modules/accounting/services/core/documentNumberRetry', () => ({
  insertWithReservedNumber: vi.fn(async (_c: string, _t: string, _p: string, _i: string, fn: (n: string) => unknown) => fn('INV-0001')),
}));
vi.mock('@/modules/accounting/services/shared/documentCurrency', () => ({
  resolveDocumentCurrency: vi.fn(async () => ({ currencyCode: 'ZAR', exchangeRate: 1 })),
}));
vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', () => ({
  invoiceLineCodingRefusal: vi.fn(async () => null),
}));

import { sql } from '@/lib/neon';
import {
  createDraftCustomerInvoice,
  InvoiceLineValidationError,
  type DraftInvoiceLineInput,
} from '@/modules/accounting/services/ar/customerInvoiceCreateService';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

type Call = [readonly string[], ...unknown[]];
const calls = (fragment: string): unknown[][] => (mockSql.mock.calls as unknown as Call[])
  .filter(([strings]) => strings.join('').includes(fragment))
  .map(([, ...values]) => values);

// Positions in the VALUES lists of the two INSERTs in customerInvoiceCreateService.ts —
// pinned by the column-order test at the bottom, so a reordered INSERT fails loudly.
const header = () => {
  const [v] = calls('INSERT INTO customer_invoices (');
  return { subtotal: v![7], taxRate: v![8], taxAmount: v![9], total: v![10], functionalInput: v![17] };
};
const lineAmounts = () => calls('INSERT INTO customer_invoice_items').map((v) => v[4]);
const storedLines = () => calls('INSERT INTO customer_invoice_items').map((v) => ({ price: v[2], qty: v[3], amount: v[4] }));

const create = (items: DraftInvoiceLineInput[], taxRate = 15) =>
  createDraftCustomerInvoice(COMPANY, USER, { clientId: CLIENT, taxRate, items });

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockImplementation(async () => [{ id: 'inv-1' }]);
});

describe('createDraftCustomerInvoice — the line discount', () => {
  it('stores a 10% discount on a R1,000 line as R900, and VAT and the totals on R900', async () => {
    await create([{ description: 'Consulting', unitPrice: 1000, quantity: 1, discount: 10 }]);

    expect(lineAmounts()).toEqual([900]);
    expect(header()).toEqual({ subtotal: 900, taxRate: 15, taxAmount: 135, total: 1035, functionalInput: 1035 });
  });

  it('prices each line rounded to the cent, and the subtotal is the sum of the stored lines', async () => {
    await create([
      { description: 'A', unitPrice: 33.33, quantity: 3, discount: 12.5 }, // 87.49125 -> 87.49
      { description: 'B', unitPrice: 0.125, quantity: 1 },                 // 0.125    -> 0.13
      { description: 'C', unitPrice: 0.125, quantity: 1 },
      { description: 'D', unitPrice: 0.125, quantity: 1 },
    ]);

    expect(lineAmounts()).toEqual([87.49, 0.13, 0.13, 0.13]);
    // Σ stored lines, not round(Σ unrounded) = 87.87: the header foots to what the lines say.
    const h = header();
    expect(h.subtotal).toBe(87.88);
    expect(h.taxAmount).toBe(13.18);
    expect(h.total).toBe(101.06);
  });

  it('leaves a line with no discount, or a zero one, at qty × price', async () => {
    await create([
      { description: 'A', unitPrice: 250, quantity: 2 },
      { description: 'B', unitPrice: 100, quantity: 1, discount: 0 },
    ]);
    expect(lineAmounts()).toEqual([500, 100]);
    expect(header()).toMatchObject({ subtotal: 600, taxAmount: 90, total: 690 });
  });

  it('takes a 100% discount to a zero line, as the draft edit does', async () => {
    await create([
      { description: 'Paid', unitPrice: 400, quantity: 1 },
      { description: 'Free', unitPrice: 100, quantity: 1, discount: 100 },
    ]);
    expect(lineAmounts()).toEqual([400, 0]);
    expect(header()).toMatchObject({ subtotal: 400, total: 460 });
  });

  it('rounds half away from zero on the decimal typed, not its float: 1.005 is 1.01, 15% of 0.10 is 0.02', async () => {
    await create([{ description: 'A', unitPrice: 1.005, quantity: 1 }]);
    expect(storedLines()).toEqual([{ price: 1.01, qty: 1, amount: 1.01 }]);
    vi.clearAllMocks();
    await create([{ description: 'B', unitPrice: 0.1, quantity: 1 }]);
    expect(header()).toMatchObject({ subtotal: 0.1, taxAmount: 0.02, total: 0.12 });
  });

  it('stores quantity and price as their columns hold them, so each stored line foots to its amount', async () => {
    await create([{ description: 'A', unitPrice: 33.333, quantity: 3 }]);
    // 3 × 33.333 = 99.999 would round to 100.00 beside a stored 33.33 × 3 = 99.99.
    expect(storedLines()).toEqual([{ price: 33.33, qty: 3, amount: 99.99 }]);
  });

  it.each([
    ['a string', { quantity: '2' }],
    ['a boolean', { quantity: true }],
    ['zero at two places', { quantity: 0.004 }],
    ['beyond its column', { quantity: 1e8 }],
  ])('refuses a quantity that is %s before writing anything', async (_label, bad) => {
    const err = await create([{ description: 'X', unitPrice: 10, ...(bad as object) } as DraftInvoiceLineInput])
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineValidationError);
    expect(calls('INSERT INTO')).toHaveLength(0);
  });

  it.each([
    ['a string', '10'],
    ['an array', [10]],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['beyond its column', 1e13],
  ])('refuses a unit price that is %s before writing anything', async (_label, bad) => {
    const err = await create([{ description: 'X', unitPrice: bad as number, quantity: 1 }])
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineValidationError);
    expect(calls('INSERT INTO')).toHaveLength(0);
  });

  it('refuses a total its column cannot hold, before writing anything', async () => {
    const err = await create([{ description: 'X', unitPrice: 9e12, quantity: 1 }, { description: 'Y', unitPrice: 9e12, quantity: 1 }])
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineValidationError);
    expect(calls('INSERT INTO')).toHaveLength(0);
  });

  it.each([
    ['negative', -10],
    ['above 100', 150],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '10'],
    ['a boolean', true],
    ['an array', [10]],
    ['an object', {}],
  ])('refuses a %s discount before writing anything', async (_label, discount) => {
    const err = await create([{ description: 'X', unitPrice: 1000, quantity: 1, discount: discount as number }])
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(InvoiceLineValidationError);
    expect((err as Error).message).toMatch(/discount/i);
    expect(calls('INSERT INTO')).toHaveLength(0);
  });

  it('lets a null discount through as no discount', async () => {
    await create([{ description: 'X', unitPrice: 1000, quantity: 1, discount: null as unknown as number }]);
    expect(lineAmounts()).toEqual([1000]);
  });

  it('pins the INSERT column order the positional reads above rely on', async () => {
    await create([{ description: 'X', unitPrice: 1, quantity: 1 }]);
    const columns = (fragment: string) => {
      const [strings] = (mockSql.mock.calls as unknown as Call[]).find(([st]) => st.join('').includes(fragment))!;
      return /\(([^)]*)\)\s*VALUES/.exec(strings.join('?'))![1]!.split(',').map((c) => c.trim());
    };
    expect(columns('INSERT INTO customer_invoices (').slice(0, 11)).toEqual([
      'company_id', 'invoice_number', 'project_id', 'customer_id', 'client_id', 'billing_period_start',
      'billing_period_end', 'subtotal', 'tax_rate', 'tax_amount', 'total_amount',
    ]);
    expect(columns('INSERT INTO customer_invoice_items').slice(0, 5)).toEqual([
      'invoice_id', 'description', 'unit_price', 'quantity', 'amount',
    ]);
    // functional_total is fx_functional(<the total>, rate): the 18th value is the total it converts.
    const [strings] = (mockSql.mock.calls as unknown as Call[]).find(([st]) => st.join('').includes('INSERT INTO customer_invoices ('))!;
    expect(strings[17]).toMatch(/public\.fx_functional\($/);
  });
});
