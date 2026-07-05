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

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

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
import { getQuote } from '@/modules/accounting/services/ar/quoteService';
import { convertToInvoice } from '@/modules/accounting/services/ar/quoteConvertService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockGetQuote = getQuote as unknown as MockedFunction<typeof getQuote>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const QUOTE_ID = '22222222-2222-2222-2222-222222222222';
const GL_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';

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
    mockSql.mockResolvedValueOnce([{ id: 'inv-1' }]); // INSERT customer_invoices RETURNING id
    mockSql.mockResolvedValueOnce([]); // INSERT customer_invoice_items
    mockSql.mockResolvedValueOnce([]); // UPDATE customer_quotes status
    mockGetQuote.mockResolvedValueOnce({ ...acceptedQuote(), status: 'converted' } as never);

    await convertToInvoice(COMPANY_ID, QUOTE_ID);

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
    ]);

    const values = insertItemCall.slice(1);
    expect(values[columnList.indexOf('amount')]).toBe(200);
    expect(values[columnList.indexOf('gl_account_id')]).toBe(GL_ACCOUNT_ID);
  });
});
