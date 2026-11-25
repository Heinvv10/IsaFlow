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

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { convertToInvoice } from '@/modules/accounting/services/ar/quoteConvertService';
import { COMPANY_ID, GL_ACCOUNT_ID, QUOTE_ID, acceptedQuote, inRequestTx, mockGetQuote, mockSql, sqlTextOf } from './helpers/quoteConvertWorld';

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
