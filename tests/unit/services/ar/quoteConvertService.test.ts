/**
 * Unit tests for quoteConvertService.ts.
 *
 * `convertToInvoice` had the same schema-mismatch bug as quoteService.ts:
 * it inserted into the real `customer_invoice_items` table using columns
 * `line_total`/`account_id`, which don't exist there either — the real
 * columns are `amount`/`gl_account_id` (confirmed via \d in isaflow_dev).
 * This pinned the fix so converting an accepted quote to an invoice no
 * longer 500s.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from 'vitest';

// Migration 874: the quote-line account check has its own real-PG suite
// (invoice-line-revenue-quotes.int.test.ts); here every account is accepted.
// The due date's terms lookup is its own tested unit (paymentTermsResolver); these tests are about column names.
vi.mock('@/modules/accounting/services/core/paymentTermsResolver', () => ({
  dueDateForContact: vi.fn(async () => '2026-12-05'), companyTermsOf: vi.fn(), getCompanyDefaultTerms: vi.fn(), contactTerms: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', () => ({ assertLineAccountIds: vi.fn(async () => undefined) }));
vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
  };
});

vi.mock('@/modules/accounting/services/core/companySettingsService', () => ({
  // convert shares the create path's 'customer_invoice' sequence (P1.5 fix:
  // the old inline 'invoice'/'INV-' counter collided with historical numbers)
  reserveNextDocumentNumber: vi.fn().mockResolvedValue('INV0000099'),
}));

vi.mock('@/modules/accounting/services/ar/quoteService', () => ({
  getQuote: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { getQuote } from '@/modules/accounting/services/ar/quoteService';
import { convertToInvoice, convertToSalesOrder, QuoteNotConvertibleError, QuoteNotInvoiceableError } from '@/modules/accounting/services/ar/quoteConvertService';
import { LineValidationError } from '@/modules/accounting/services/ar/quoteLineChecks';
import { InvoiceVatNotRegisteredRefusal } from '@/modules/accounting/services/ar/invoiceLineVatTypes';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockGetQuote = getQuote as unknown as MockedFunction<typeof getQuote>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const QUOTE_ID = '22222222-2222-2222-2222-222222222222';
const GL_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';

/**
 * `claimUnderLockTimeout` refuses to claim outside a request transaction — the
 * claim would autocommit and could not be rolled back with the writes that
 * follow it. These unit tests mock `sql`, so the client only has to exist;
 * `SET LOCAL` goes to the stub.
 */
const requestCtx = {
  client: { query: vi.fn() }, userId: 'u1', companyId: COMPANY_ID, claims: {},
} as unknown as Parameters<typeof als.run>[0];
const inRequestTx = <T>(fn: () => Promise<T>): Promise<T> => als.run(requestCtx, fn);


function acceptedQuote() {
  return {
    id: QUOTE_ID,
    quoteNumber: 'QUO-00001',
    clientId: null,
    customerName: 'Acme Corp',
    quoteDate: '2026-07-01',
    expiryDate: null,
    status: 'accepted',
    subtotal: 200,
    taxAmount: 30,
    total: 230,
    notes: null,
    terms: null,
    convertedInvoiceId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    lines: [
      {
        id: '44444444-4444-4444-4444-444444444444',
        quoteId: QUOTE_ID,
        lineNumber: 1,
        description: 'Consulting services',
        quantity: 2,
        unitPrice: 100,
        taxRate: 15,
        lineTotal: 200,
        accountId: GL_ACCOUNT_ID,
      },
    ],
  };
}

function sqlTextOf(call: unknown[]): string {
  return (call[0] as readonly string[]).join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('convertToInvoice — writes real customer_invoice_items columns', () => {
  it('inserts line items using amount/gl_account_id, not line_total/account_id', async () => {
    mockGetQuote.mockResolvedValueOnce(acceptedQuote() as never);
    mockSql.mockResolvedValueOnce([{ id: QUOTE_ID }]); // claiming UPDATE customer_quotes
    mockSql.mockResolvedValueOnce([{ id: 'inv-1' }]); // INSERT customer_invoices RETURNING id
    mockSql.mockResolvedValueOnce([]); // INSERT customer_invoice_items
    mockSql.mockResolvedValueOnce([]); // UPDATE customer_quotes converted_invoice_id
    mockGetQuote.mockResolvedValueOnce({ ...acceptedQuote(), status: 'converted' } as never);

    await inRequestTx(() => convertToInvoice(COMPANY_ID, QUOTE_ID));

    // Pin the shared sequence — reverting to the old 'invoice'/'INV-' counter
    // (collides with historical numbers) must fail here.
    const { reserveNextDocumentNumber } = await import(
      '@/modules/accounting/services/core/companySettingsService'
    );
    expect(reserveNextDocumentNumber).toHaveBeenCalledWith(COMPANY_ID, 'customer_invoice');

    const insertItemCall = mockSql.mock.calls.find((call) =>
      sqlTextOf(call).includes('INSERT INTO customer_invoice_items'),
    )!;
    const text = sqlTextOf(insertItemCall);
    const columnList = text.match(/INSERT INTO customer_invoice_items\s*\(([^)]+)\)/)![1]!
      .split(',')
      .map((c) => c.trim());

    expect(columnList).toEqual([
      'invoice_id',
      'description',
      'quantity',
      'unit_price',
      'tax_rate',
      'amount',
      'gl_account_id',
      'cc1_id',
      'item_id',
      'tax_amount',
      'vat_type',
      'line_position',
    ]);

    const values = insertItemCall.slice(1);
    expect(values[columnList.indexOf('amount')]).toBe(200);
    expect(values[columnList.indexOf('gl_account_id')]).toBe(GL_ACCOUNT_ID);
    // A quote with no customer has no FNO to store (and sends no query for one).
    expect(values[columnList.indexOf('cc1_id')]).toBeNull();
    // A legacy quote (no line typed) converts untyped, as before migration 1024.
    expect([values[columnList.indexOf('tax_amount')], values[columnList.indexOf('vat_type')]]).toEqual([null, null]);
  });
});

describe('convertToInvoice: the invoice header rate (audit 11 Nov 2026 item 5)', () => {
  const line = (taxRate: number, n: number) => ({ ...acceptedQuote().lines[0]!, id: `4444444${n}-4444-4444-4444-444444444444`, taxRate });
  async function convert(lines: ReturnType<typeof line>[]) {
    mockGetQuote.mockResolvedValueOnce({ ...acceptedQuote(), lines } as never);
    mockSql.mockResolvedValueOnce([{ id: QUOTE_ID }]); // claim
    mockSql.mockResolvedValueOnce([{ id: 'inv-1' }]); // INSERT customer_invoices
    mockGetQuote.mockResolvedValueOnce({ ...acceptedQuote(), status: 'converted' } as never);
    await inRequestTx(() => convertToInvoice(COMPANY_ID, QUOTE_ID));
    const head = mockSql.mock.calls.find((c) => sqlTextOf(c).includes('INSERT INTO customer_invoices'))!;
    const cols = sqlTextOf(head).match(/INSERT INTO customer_invoices\s*\(([^)]+)\)/)![1]!.split(',').map((c) => c.trim());
    expect(cols[cols.indexOf('total_amount') + 1]).toBe('tax_rate');
    const binds = head.slice(1);
    const items = mockSql.mock.calls.filter((c) => sqlTextOf(c).includes('INSERT INTO customer_invoice_items'));
    // tax_rate is bound straight after total_amount (the quote's total, 230); items bind tax_rate fifth.
    return { headerRate: binds[binds.indexOf(230) + 1], itemRates: items.map((c) => c.slice(1)[4]) };
  }

  it('a uniform 0% quote writes header tax_rate 0 and items at 0', async () => {
    expect(await convert([line(0, 1), line(0, 2)])).toEqual({ headerRate: 0, itemRates: [0, 0] });
  });

  it('a mixed quote writes the standard header rate and keeps each item rate', async () => {
    expect(await convert([line(15, 1), line(0, 2)])).toEqual({ headerRate: 15, itemRates: [15, 0] });
  });
});

describe('convertToInvoice: a typed quote (migration 1024)', () => {
  const typed = (vatPeriod: string) => {
    const base = acceptedQuote();
    mockGetQuote.mockResolvedValueOnce({
      ...base, subtotal: 250, taxAmount: 30, total: 280, amountsAre: 'exclusive', lines: [
        { ...base.lines[0]!, vatType: 'standard', taxAmount: 30 },
        { ...base.lines[0]!, id: '45555555-4444-4444-4444-444444444444', description: 'Export', quantity: 1, unitPrice: 50, lineTotal: 50, taxRate: 0, vatType: 'zero_rated', taxAmount: 0 },
      ],
    } as never);
    mockGetQuote.mockResolvedValueOnce({ ...base, status: 'converted' } as never);
    mockSql.mockImplementation((async (...call: unknown[]) => {
      const t = sqlTextOf(call);
      if (t.includes('FROM companies')) return [{ vat_period: vatPeriod, vat_system_type: null, customer_vat: null }];
      if (t.includes('UPDATE customer_quotes')) return [{ id: QUOTE_ID }];
      if (t.includes('INSERT INTO customer_invoices')) return [{ id: 'inv-1' }];
      return [];
    }) as never);
  };
  const row = (call: unknown[], table: string) => {
    // due_date_source and status are bound as literals ('terms', 'draft'), not values.
    const cols = sqlTextOf(call).match(new RegExp(`INSERT INTO ${table}\\s*\\(([^)]+)\\)`))![1]!.split(',').map((c) => c.trim())
      .filter((c) => c !== 'due_date_source' && c !== 'status');
    return Object.fromEntries(cols.map((c, i) => [c, call[i + 1]]));
  };
  afterEach(() => { mockSql.mockReset(); mockGetQuote.mockReset(); });

  it('each invoice line carries the quote line\'s type, net and VAT; the header the quote\'s totals and mode', async () => {
    typed('bi-monthly');
    await inRequestTx(() => convertToInvoice(COMPANY_ID, QUOTE_ID));
    const head = row(mockSql.mock.calls.find((c) => sqlTextOf(c).includes('INSERT INTO customer_invoices'))!, 'customer_invoices');
    expect([head.subtotal, head.tax_amount, head.total_amount, head.tax_rate, head.amounts_are]).toEqual([250, 30, 280, 15, 'exclusive']);
    const items = mockSql.mock.calls.filter((c) => sqlTextOf(c).includes('INSERT INTO customer_invoice_items')).map((c) => row(c, 'customer_invoice_items'));
    expect(items.map((i) => [i.vat_type, i.amount, i.tax_amount, i.tax_rate, i.line_position])).toEqual([['standard', 200, 30, 15, 0], ['zero_rated', 50, 0, 0, 1]]);
  });

  it('returns the conversion\'s warnings (none when the totals agree)', async () => {
    typed('bi-monthly');
    expect((await inRequestTx(() => convertToInvoice(COMPANY_ID, QUOTE_ID)))!.warnings).toEqual([]);
  });

  it('a VAT refusal is raised before the claim: nothing is written', async () => {
    typed('none');
    await expect(inRequestTx(() => convertToInvoice(COMPANY_ID, QUOTE_ID))).rejects.toThrow(InvoiceVatNotRegisteredRefusal);
    expect(mockSql.mock.calls.some((c) => /UPDATE|INSERT/.test(sqlTextOf(c)))).toBe(false);
  });
});

describe('a quote its status refuses answers 409 before any VAT refusal (the winner\'s id)', () => {
  it('convertToInvoice on a converted, partly typed quote: QuoteNotInvoiceableError with the existing invoice id', async () => {
    mockSql.mockReset();
    const base = acceptedQuote();
    mockGetQuote.mockResolvedValueOnce({ ...base, status: 'converted', convertedInvoiceId: 'inv-9',
      lines: [{ ...base.lines[0]!, vatType: 'standard', taxAmount: 30 }, { ...base.lines[0]!, vatType: null, taxAmount: null }] } as never);
    mockSql.mockResolvedValueOnce([{ status: 'converted', converted_invoice_id: 'inv-9' }] as never);
    const err = await inRequestTx(() => convertToInvoice(COMPANY_ID, QUOTE_ID)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoteNotInvoiceableError);
    expect(err).toMatchObject({ quoteStatus: 'converted', existingInvoiceId: 'inv-9' });
    expect(mockSql.mock.calls.some((c) => /UPDATE|INSERT/.test(sqlTextOf(c)))).toBe(false);
  });

  it('convertToSalesOrder on a converted inclusive quote: QuoteNotConvertibleError with the existing order id', async () => {
    mockSql.mockReset();
    mockGetQuote.mockResolvedValueOnce({ ...acceptedQuote(), status: 'converted_to_order', amountsAre: 'inclusive' } as never);
    mockSql.mockResolvedValueOnce([{ status: 'converted_to_order', converted_order_id: 'so-3' }] as never);
    const err = await inRequestTx(() => convertToSalesOrder(COMPANY_ID, QUOTE_ID)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoteNotConvertibleError);
    expect(err).toMatchObject({ existingOrderId: 'so-3' });
  });
});

describe('both conversion links are checked first: the 409 precedes any 400', () => {
  it('convertToInvoice on an accepted quote already linked to an ORDER, with a VAT problem: QuoteNotInvoiceableError', async () => {
    mockSql.mockReset();
    const base = acceptedQuote();
    mockGetQuote.mockResolvedValueOnce({ ...base, convertedOrderId: 'so-1',
      lines: [{ ...base.lines[0]!, vatType: 'standard', taxAmount: 30 }, { ...base.lines[0]!, vatType: null, taxAmount: null }] } as never);
    mockSql.mockResolvedValueOnce([{ status: 'accepted', converted_invoice_id: null }] as never);
    await expect(inRequestTx(() => convertToInvoice(COMPANY_ID, QUOTE_ID))).rejects.toBeInstanceOf(QuoteNotInvoiceableError);
    expect(mockSql.mock.calls.some((c) => /UPDATE|INSERT/.test(sqlTextOf(c)))).toBe(false);
  });

  it('convertToSalesOrder on an accepted inclusive quote already linked to an ORDER: QuoteNotConvertibleError with that order', async () => {
    mockSql.mockReset();
    mockGetQuote.mockResolvedValueOnce({ ...acceptedQuote(), convertedOrderId: 'so-2', amountsAre: 'inclusive' } as never);
    mockSql.mockResolvedValueOnce([{ status: 'accepted', converted_order_id: 'so-2' }] as never);
    const err = await inRequestTx(() => convertToSalesOrder(COMPANY_ID, QUOTE_ID)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoteNotConvertibleError);
    expect(err).toMatchObject({ existingOrderId: 'so-2' });
  });
});

describe('a 409 names both links (review round 3)', () => {
  it('convertToSalesOrder on a quote already INVOICED: the invoice id rides on the refusal', async () => {
    mockSql.mockReset();
    mockGetQuote.mockResolvedValueOnce({ ...acceptedQuote(), status: 'converted', convertedInvoiceId: 'inv-7' } as never);
    mockSql.mockResolvedValueOnce([{ status: 'converted', converted_invoice_id: 'inv-7', converted_order_id: null }] as never);
    const err = await inRequestTx(() => convertToSalesOrder(COMPANY_ID, QUOTE_ID)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoteNotConvertibleError);
    expect(err).toMatchObject({ existingOrderId: null, existingInvoiceId: 'inv-7' });
  });

  it('convertToInvoice on a quote already turned into an ORDER: the order id rides on the refusal', async () => {
    mockSql.mockReset();
    mockGetQuote.mockResolvedValueOnce({ ...acceptedQuote(), status: 'converted_to_order', convertedOrderId: 'so-8' } as never);
    mockSql.mockResolvedValueOnce([{ status: 'converted_to_order', converted_invoice_id: null, converted_order_id: 'so-8' }] as never);
    const err = await inRequestTx(() => convertToInvoice(COMPANY_ID, QUOTE_ID)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoteNotInvoiceableError);
    expect(err).toMatchObject({ existingInvoiceId: null, existingOrderId: 'so-8' });
  });
});

describe('convertToSalesOrder: a typed quote with an exempt line', () => {
  it('is refused before the claim (a sales order would invoice it zero-rated)', async () => {
    mockSql.mockReset();
    const base = acceptedQuote();
    mockGetQuote.mockResolvedValueOnce({ ...base, lines: [{ ...base.lines[0]!, vatType: 'exempt', taxAmount: 0, taxRate: 0 }] } as never);
    await expect(inRequestTx(() => convertToSalesOrder(COMPANY_ID, QUOTE_ID))).rejects.toThrow(/exempt from VAT/);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('convertToSalesOrder: an inclusive quote', () => {
  it('is refused before the claim: a sales order holds ex-VAT prices only', async () => {
    mockSql.mockReset();
    mockGetQuote.mockResolvedValueOnce({ ...acceptedQuote(), amountsAre: 'inclusive' } as never);
    await expect(inRequestTx(() => convertToSalesOrder(COMPANY_ID, QUOTE_ID))).rejects.toThrow(LineValidationError);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
