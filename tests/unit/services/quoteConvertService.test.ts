// RED phase — written before the fix (A–Z programme P1.2 residual, audit H2/H3 family)
/**
 * Two residual quote bugs after PR #192 aligned quoteService reads/inserts:
 *
 * 1. mapQuote did String(r.quote_date) on a pg Date → "Sat Jul 05 2026 …
 *    GMT+0200 (South Africa Standard Time)" → feeding quote.quoteDate back
 *    into the conversion INSERT throws `time zone "gmt+0200" not recognized`
 *    (reproduced live on dev, 2026-07-05). Dates must go through fmtDate.
 *
 * 2. convertToInvoice's INSERT INTO customer_invoice_items used
 *    line_total/account_id — the real columns are amount/gl_account_id
 *    (same H2 column-mismatch class, second site, found by PR #196 review).
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

const sqlTexts: string[] = [];
const sqlResults: unknown[][] = [];

vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sqlMock = Object.assign(
    vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
      sqlTexts.push(strings.join('?'));
      return Promise.resolve(sqlResults.shift() ?? []);
    }),
    { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) },
  );
  return {
    ...original,
    sql: sqlMock, // real fmtDate stays — the date behavior under test is REAL
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/core/companySettingsService', () => ({
  // convert now shares the create path's 'customer_invoice' sequence
  reserveNextDocumentNumber: vi.fn().mockResolvedValue('INV0000099'),
}));

import { getQuote } from '@/modules/accounting/services/ar/quoteService';
import { convertToInvoice } from '@/modules/accounting/services/ar/quoteConvertService';
import { reserveNextDocumentNumber } from '@/modules/accounting/services/core/companySettingsService';

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const QUOTE_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';

function quoteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: QUOTE_ID,
    quote_number: 'QUO-0000001',
    client_id: 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
    customer_name: 'Test Customer',
    // pg returns DATE columns as JS Date at local midnight (UTC+2 here)
    quote_date: new Date(2026, 6, 5),
    expiry_date: new Date(2026, 6, 19),
    status: 'accepted',
    subtotal: '100.00',
    tax_amount: '15.00',
    total: '115.00',
    notes: null,
    terms: null,
    converted_invoice_id: null,
    created_at: new Date(2026, 6, 5),
    updated_at: new Date(2026, 6, 5),
    ...overrides,
  };
}

const lineRow = {
  id: 'dddddddd-0000-4000-8000-dddddddddddd',
  quote_id: QUOTE_ID,
  sort_order: 1,
  description: 'Widget',
  quantity: '2',
  unit_price: '50.00',
  tax_rate: '15',
  amount: '100.00',
  gl_account_id: null,
};

describe('quote date serialization + convert column names (P1.2 residual)', () => {
  beforeEach(() => {
    sqlTexts.length = 0;
    sqlResults.length = 0;
    vi.clearAllMocks();
  });

  it('getQuote returns plain YYYY-MM-DD strings for pg DATE columns', async () => {
    sqlResults.push([quoteRow()], [lineRow]);

    const quote = await getQuote(COMPANY_ID, QUOTE_ID);

    expect(quote).toBeTruthy();
    // String(pgDate) produces "Sat Jul 05 2026 … GMT+0200 …" which Postgres
    // rejects when fed back into an INSERT. fmtDate gives the wire format.
    expect(quote!.quoteDate).toBe('2026-07-05');
    expect(quote!.expiryDate).toBe('2026-07-19');
  });

  it('convertToInvoice inserts items with amount/gl_account_id (not line_total/account_id)', async () => {
    // convertToInvoice → getQuote (quote+lines), doc-number INSERT, invoice
    // INSERT, item INSERT(s), quote UPDATE, final getQuote (quote+lines).
    sqlResults.push(
      [quoteRow()],
      [lineRow],
      [{ id: 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee' }], // invoice insert
      [], // item insert
      [], // quote update
      [quoteRow({ status: 'converted', converted_invoice_id: 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee' })],
      [lineRow],
    );

    const result = await convertToInvoice(COMPANY_ID, QUOTE_ID, 'ffffffff-0000-4000-8000-ffffffffffff');

    expect(result).toBeTruthy();
    const itemInsert = sqlTexts.find((t) => /INSERT INTO customer_invoice_items/i.test(t));
    expect(itemInsert, 'item INSERT must exist').toBeTruthy();
    expect(itemInsert!).toMatch(/\bamount\b/);
    expect(itemInsert!).toMatch(/\bgl_account_id\b/);
    expect(itemInsert!).not.toMatch(/\bline_total\b/);
    expect(itemInsert!).not.toMatch(/(?<!gl_)\baccount_id\b/);

    // Pin the SHARED sequence: reverting to the old 'invoice'/'INV-' counter
    // (which collided with historical numbers) must fail this test.
    expect(reserveNextDocumentNumber).toHaveBeenCalledWith(COMPANY_ID, 'customer_invoice');
  });

  it('retries with a fresh number when the INSERT hits a legacy-number collision (23505)', async () => {
    const dupe = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    sqlResults.push(
      [quoteRow()],
      [lineRow],
      // first invoice INSERT → 23505; wired via mockImplementation below
    );
    const mockSqlFn = (await import('@/lib/neon')).sql as unknown as ReturnType<typeof vi.fn>;
    let invoiceInsertCalls = 0;
    mockSqlFn.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      sqlTexts.push(text);
      if (/INSERT INTO customer_invoices/i.test(text)) {
        invoiceInsertCalls += 1;
        if (invoiceInsertCalls === 1) return Promise.reject(dupe);
        return Promise.resolve([{ id: 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee' }]);
      }
      return Promise.resolve(sqlResults.shift() ?? []);
    });

    const result = await convertToInvoice(COMPANY_ID, QUOTE_ID, 'ffffffff-0000-4000-8000-ffffffffffff');

    expect(result).toBeTruthy();
    expect(invoiceInsertCalls).toBe(2);
    // a fresh number was reserved for the retry
    expect(reserveNextDocumentNumber).toHaveBeenCalledTimes(2);
  });
});
