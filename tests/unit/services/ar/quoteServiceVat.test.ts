/**
 * Audit 11 Nov 2026 item 5: quoteService defaulted a missing line rate to 15%, never checked a supplied one, and priced
 * with float rounding. A line's rate is now kept (0 included), refused outside 0 to 100, and an omitted rate takes the
 * company's: 0 when it is not VAT registered. Totals are invoiceTotals per rate.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', () => ({ assertLineAccountIds: vi.fn(async () => undefined) }));
vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(), { transaction: vi.fn() }),
  withTransaction: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  fmtDate: (d: unknown) => String(d),
}));

import { sql } from '@/lib/neon';
import { createQuote, LineValidationError } from '@/modules/accounting/services/ar/quoteService';
import { quoteTotals } from '@/modules/accounting/services/ar/quoteLineTax';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const QUOTE_ID = '22222222-2222-2222-2222-222222222222';

const text = (call: unknown[]) => (call[0] as readonly string[]).join(' ');
const header = { id: QUOTE_ID, quote_number: 'QUO1', client_id: null, customer_name: 'Acme', quote_date: '2026-11-11', expiry_date: null,
  status: 'draft', subtotal: '0', tax_amount: '0', total: '0', notes: null, terms: null, converted_invoice_id: null, created_at: '', updated_at: '' };

/** Scripts every query: the companies lookup answers `vatPeriod`; the INSERT … RETURNING id and getQuote answer a quote. */
function serve(vatPeriod = 'bi-monthly') {
  mockSql.mockImplementation(async (...call: unknown[]) => {
    const t = text(call);
    if (t.includes('FROM companies')) return [{ vat_period: vatPeriod, vat_system_type: null }];
    if (t.includes('document_sequences') || t.includes('used')) return [{ used: 0, prefix: 'QUO', padding: 7 }];
    if (t.includes('INSERT INTO customer_quotes')) return [{ id: QUOTE_ID }];
    if (t.includes('FROM customer_quotes')) return [header];
    return [];
  });
}

type Line = { description: string; quantity: number; unitPrice: number; taxRate?: number };
const create = (lines: Line[]) => createQuote(COMPANY_ID, { customerName: 'Acme', lines }, 'u1');

/** The header INSERT's subtotal, tax_amount, total and each line's tax_rate, read from the values bound. */
function written() {
  const calls = mockSql.mock.calls;
  const head = calls.find((c) => text(c).includes('INSERT INTO customer_quotes'))!;
  const lines = calls.filter((c) => text(c).includes('INSERT INTO customer_quote_lines'));
  // VALUES (company, number, client, name, date, expiry, subtotal, tax_amount, total, …)
  return { subtotal: head[7], taxAmount: head[8], total: head[9], rates: lines.map((c) => c[6]) };
}

beforeEach(() => { vi.clearAllMocks(); mockSql.mockReset(); serve(); });

describe('createQuote VAT per line', () => {
  it('taxRate 0 persists 0 and the header tax is 0', async () => {
    await create([{ description: 'A', quantity: 2, unitPrice: 100, taxRate: 0 }]);
    expect(written()).toEqual({ subtotal: 200, taxAmount: 0, total: 200, rates: [0] });
  });

  it('standard 15%', async () => {
    await create([{ description: 'A', quantity: 2, unitPrice: 100, taxRate: 15 }]);
    expect(written()).toEqual({ subtotal: 200, taxAmount: 30, total: 230, rates: [15] });
  });

  it('mixed 15% and 0% lines total by rate', async () => {
    await create([{ description: 'A', quantity: 1, unitPrice: 100, taxRate: 15 }, { description: 'B', quantity: 1, unitPrice: 50, taxRate: 0 }]);
    expect(written()).toEqual({ subtotal: 150, taxAmount: 15, total: 165, rates: [15, 0] });
  });

  it('an omitted rate on a company that is not VAT registered stores 0, read for this company only', async () => {
    serve('none');
    await create([{ description: 'A', quantity: 1, unitPrice: 100 }]);
    expect(written()).toEqual({ subtotal: 100, taxAmount: 0, total: 100, rates: [0] });
    const lookup = mockSql.mock.calls.find((c) => text(c).includes('FROM companies'))!;
    expect(text(lookup)).toMatch(/WHERE id = /);
    expect(lookup.slice(1)).toEqual([COMPANY_ID]);
  });

  it('an omitted rate on a registered company stores 15', async () => {
    await create([{ description: 'A', quantity: 1, unitPrice: 100 }]);
    expect(written().rates).toEqual([15]);
  });

  it('does not read the company when every line carries its rate', async () => {
    await create([{ description: 'A', quantity: 1, unitPrice: 100, taxRate: 0 }]);
    expect(mockSql.mock.calls.some((c) => text(c).includes('FROM companies'))).toBe(false);
  });

  it.each([-1, 101, Number.NaN, '15%' as unknown as number])('refuses a rate of %s, naming the line, before any write', async (rate) => {
    await expect(create([{ description: 'A', quantity: 1, unitPrice: 1, taxRate: 15 }, { description: 'B', quantity: 1, unitPrice: 1, taxRate: rate }]))
      .rejects.toThrow(new LineValidationError('Line 2: VAT rate must be a number from 0 to 100'));
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('quoteTotals', () => {
  it('rounds the tax in exact decimal, as the invoice does (R6.70 at 15% is R1.005, so R1.01)', () => {
    expect(quoteTotals([{ quantity: 1, unitPrice: 6.7, taxRate: 15 }])).toEqual({ subtotal: 6.7, taxAmount: 1.01, total: 7.71 });
  });
});
