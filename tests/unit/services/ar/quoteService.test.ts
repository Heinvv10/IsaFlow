/**
 * Unit tests for quoteService.ts.
 *
 * The customer-quotes feature has NEVER worked in any environment: the code
 * was written against a schema that does not exist. The real
 * `customer_quote_lines` table is:
 *   (id, quote_id, description, quantity, unit_price, amount, tax_rate,
 *    gl_account_id, sort_order, created_at) — `amount` NOT NULL.
 * The old code used `line_number`, `line_total`, `account_id`, none of which
 * exist on the table, so every INSERT/SELECT 500'd.
 *
 * These tests pin the service to the REAL columns while keeping the
 * external QuoteLine TS interface stable (lineNumber/lineTotal/accountId).
 *
 *  1. mapLine (via getQuote) maps sort_order -> lineNumber, amount ->
 *     lineTotal, gl_account_id -> accountId.
 *  2. getQuote's line query orders by sort_order, not line_number.
 *  3. createQuote inserts customer_quote_lines using the exact real column
 *     list (sort_order, amount, gl_account_id) and computes amount as
 *     quantity * unitPrice (tax-exclusive, matching customer_invoice_items).
 *  4. updateQuote re-inserts lines using the same real column list.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn() };
});

import { sql } from '@/lib/neon';
import { getQuote, createQuote, updateQuote } from '@/modules/accounting/services/ar/quoteService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const QUOTE_ID = '22222222-2222-2222-2222-222222222222';
const CLIENT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const GL_ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';

function quoteHeaderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: QUOTE_ID,
    quote_number: 'QUO-00001',
    client_id: CLIENT_ID,
    customer_name: 'Acme Corp',
    quote_date: '2026-07-01',
    expiry_date: '2026-07-31',
    status: 'draft',
    subtotal: '200.00',
    tax_amount: '30.00',
    total: '230.00',
    notes: null,
    terms: null,
    converted_invoice_id: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A raw row as it actually comes back from the real `customer_quote_lines` table. */
function realQuoteLineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '66666666-6666-6666-6666-666666666666',
    quote_id: QUOTE_ID,
    description: 'Consulting services',
    quantity: '2.00',
    unit_price: '100.00',
    amount: '200.00',
    tax_rate: '15.00',
    gl_account_id: GL_ACCOUNT_ID,
    sort_order: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Extracts the raw SQL text (first literal segment) of a tagged-template call. */
function sqlTextOf(call: unknown[]): string {
  const strings = call[0] as readonly string[];
  return strings.join(' ');
}

/** Parses the `INSERT INTO table (col, col, ...)` column list from raw SQL text. */
function insertColumns(text: string): string[] {
  const match = text.match(/INSERT INTO customer_quote_lines\s*\(([^)]+)\)/);
  if (!match) throw new Error(`No customer_quote_lines INSERT column list found in: ${text}`);
  return match[1]!.split(',').map((c) => c.trim());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getQuote — reads real customer_quote_lines columns', () => {
  it('orders lines by sort_order (not line_number)', async () => {
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]); // header lookup
    mockSql.mockResolvedValueOnce([realQuoteLineRow()]); // lines lookup

    await getQuote(COMPANY_ID, QUOTE_ID);

    const lineQueryCall = mockSql.mock.calls[1]!;
    const text = sqlTextOf(lineQueryCall);
    expect(text).toContain('ORDER BY sort_order');
    expect(text).not.toContain('line_number');
  });

  it('maps sort_order -> lineNumber, amount -> lineTotal, gl_account_id -> accountId', async () => {
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]);
    mockSql.mockResolvedValueOnce([
      realQuoteLineRow({ sort_order: 1, amount: '200.00', gl_account_id: GL_ACCOUNT_ID }),
    ]);

    const quote = await getQuote(COMPANY_ID, QUOTE_ID);

    expect(quote).not.toBeNull();
    expect(quote!.lines).toHaveLength(1);
    const line = quote!.lines![0]!;
    expect(line.lineNumber).toBe(1);
    expect(line.lineTotal).toBe(200);
    expect(line.accountId).toBe(GL_ACCOUNT_ID);
  });

  it('maps a null gl_account_id to a null accountId', async () => {
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]);
    mockSql.mockResolvedValueOnce([realQuoteLineRow({ gl_account_id: null })]);

    const quote = await getQuote(COMPANY_ID, QUOTE_ID);

    expect(quote!.lines![0]!.accountId).toBeNull();
  });
});

describe('createQuote — writes real customer_quote_lines columns', () => {
  it('inserts lines using sort_order/amount/gl_account_id, not line_number/line_total/account_id', async () => {
    mockSql.mockResolvedValueOnce([]); // nextQuoteNumber — no existing quotes
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]); // INSERT customer_quotes RETURNING *
    mockSql.mockResolvedValueOnce([]); // INSERT line 1
    mockSql.mockResolvedValueOnce([]); // INSERT line 2
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]); // getQuote header
    mockSql.mockResolvedValueOnce([
      realQuoteLineRow({ sort_order: 1 }),
      realQuoteLineRow({ id: '77777777-7777-7777-7777-777777777777', sort_order: 2 }),
    ]); // getQuote lines

    await createQuote(
      COMPANY_ID,
      {
        customerName: 'Acme Corp',
        clientId: CLIENT_ID,
        lines: [
          { description: 'Consulting services', quantity: 2, unitPrice: 100, taxRate: 15, accountId: GL_ACCOUNT_ID },
          { description: 'Travel', quantity: 1, unitPrice: 50, taxRate: 15 },
        ],
      },
      USER_ID,
    );

    const insertLineCalls = mockSql.mock.calls.filter((call) =>
      sqlTextOf(call).includes('INSERT INTO customer_quote_lines'),
    );
    expect(insertLineCalls).toHaveLength(2);

    for (const call of insertLineCalls) {
      const columns = insertColumns(sqlTextOf(call));
      expect(columns).toEqual([
        'quote_id',
        'sort_order',
        'description',
        'quantity',
        'unit_price',
        'tax_rate',
        'amount',
        'gl_account_id',
      ]);
    }
  });

  it('computes amount as quantity * unitPrice, tax-exclusive (matches customer_invoice_items.amount semantics)', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]);
    mockSql.mockResolvedValueOnce([]); // capture this call's values below
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]);
    mockSql.mockResolvedValueOnce([realQuoteLineRow()]);

    await createQuote(
      COMPANY_ID,
      {
        customerName: 'Acme Corp',
        lines: [{ description: 'Consulting services', quantity: 2, unitPrice: 100, taxRate: 15 }],
      },
      USER_ID,
    );

    const insertLineCall = mockSql.mock.calls.find((call) =>
      sqlTextOf(call).includes('INSERT INTO customer_quote_lines'),
    )!;
    const columns = insertColumns(sqlTextOf(insertLineCall));
    const values = insertLineCall.slice(1);
    const amountIdx = columns.indexOf('amount');
    // amount must be qty(2) * unitPrice(100) = 200 — NOT 230 (which would
    // wrongly include the 15% tax rolled into the line amount).
    expect(values[amountIdx]).toBe(200);
  });

  it('passes sort_order as the 1-based line position', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]);
    mockSql.mockResolvedValueOnce([realQuoteLineRow(), realQuoteLineRow({ sort_order: 2 })]);

    await createQuote(
      COMPANY_ID,
      {
        customerName: 'Acme Corp',
        lines: [
          { description: 'Line A', quantity: 1, unitPrice: 10 },
          { description: 'Line B', quantity: 1, unitPrice: 20 },
        ],
      },
      USER_ID,
    );

    const insertLineCalls = mockSql.mock.calls.filter((call) =>
      sqlTextOf(call).includes('INSERT INTO customer_quote_lines'),
    );
    const sortOrderIdxA = insertColumns(sqlTextOf(insertLineCalls[0]!)).indexOf('sort_order');
    const sortOrderIdxB = insertColumns(sqlTextOf(insertLineCalls[1]!)).indexOf('sort_order');
    expect(insertLineCalls[0]!.slice(1)[sortOrderIdxA]).toBe(1);
    expect(insertLineCalls[1]!.slice(1)[sortOrderIdxB]).toBe(2);
  });
});

describe('updateQuote — re-inserts lines using real columns', () => {
  it('inserts replacement lines using sort_order/amount/gl_account_id', async () => {
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]); // existing header (getQuote)
    mockSql.mockResolvedValueOnce([realQuoteLineRow()]); // existing lines (getQuote)
    mockSql.mockResolvedValueOnce([]); // UPDATE customer_quotes
    mockSql.mockResolvedValueOnce([]); // DELETE customer_quote_lines
    mockSql.mockResolvedValueOnce([]); // INSERT replacement line
    mockSql.mockResolvedValueOnce([quoteHeaderRow()]); // getQuote header (return value)
    mockSql.mockResolvedValueOnce([realQuoteLineRow()]); // getQuote lines (return value)

    await updateQuote(COMPANY_ID, QUOTE_ID, {
      customerName: 'Acme Corp',
      lines: [{ description: 'Updated line', quantity: 3, unitPrice: 40, accountId: GL_ACCOUNT_ID }],
    });

    const insertLineCall = mockSql.mock.calls.find((call) =>
      sqlTextOf(call).includes('INSERT INTO customer_quote_lines'),
    )!;
    const columns = insertColumns(sqlTextOf(insertLineCall));
    expect(columns).toEqual([
      'quote_id',
      'sort_order',
      'description',
      'quantity',
      'unit_price',
      'tax_rate',
      'amount',
      'gl_account_id',
    ]);
    const values = insertLineCall.slice(1);
    expect(values[columns.indexOf('amount')]).toBe(120); // 3 * 40
    expect(values[columns.indexOf('gl_account_id')]).toBe(GL_ACCOUNT_ID);
  });
});
