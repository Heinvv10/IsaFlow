/**
 * applyReapplyCustomerTerms on an invoice row whose customer cannot be read (COALESCE(client_id, customer_id) is NULL):
 * it is skipped as terms_not_set, no customer query is made for it (String(null) is 'null', which the ::UUID cast would
 * throw on, rolling back the whole batch), and a valid invoice confirmed in the same batch is still written.
 *
 * Mocked rather than integration: customer_invoices.customer_id is NOT NULL, so the database cannot hold such a row today;
 * the lock helper is what hands the service the row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  queries: [] as { text: string; values: unknown[] }[],
}));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    state.queries.push({ text, values });
    if (text.includes('FROM customers')) return [{ payment_terms: 3, payment_terms_type: 'statement_months' }];
    return [];
  }),
}));
vi.mock('@/modules/accounting/services/ar/customerInvoiceRowLock', () => ({
  lockCustomerInvoiceForUpdate: vi.fn(async (_c: string, id: string) => state.rows.get(id) ?? null),
}));

import { applyReapplyCustomerTerms } from '@/modules/accounting/services/ar/reapplyTerms';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const BAD = 'a0000000-0000-4000-8000-000000000001';
const GOOD = 'b0000000-0000-4000-8000-000000000002';
const CUST = 'd0000000-0000-4000-8000-000000000003';
const row = (id: string, customerId: string | null) => ({
  id, invoice_number: `INV-${id.slice(0, 1)}`, status: 'approved', deleted_at: null, total_amount: 1150, amount_paid: 0,
  invoice_date: '2026-09-16', due_date: '2026-12-15', due_date_source: 'legacy', customer_id: customerId,
});
const item = (id: string) => ({ id, dueDate: '2026-12-31', fromDueDate: '2026-12-15', fromSource: 'legacy' });

beforeEach(() => {
  state.queries = [];
  state.rows = new Map([[BAD, row(BAD, null)], [GOOD, row(GOOD, CUST)]]);
});

describe('an invoice with no readable customer in an apply batch', () => {
  it('is skipped as terms_not_set without a customer query, and the valid invoice is still written', async () => {
    const r = await applyReapplyCustomerTerms(COMPANY, [item(BAD), item(GOOD)]);
    expect(r.skipped).toEqual([{ id: BAD, reason: 'terms_not_set' }]);
    expect(r.updated).toEqual([{ id: GOOD, invoiceNumber: 'INV-b', from: '2026-12-15', to: '2026-12-31' }]);
    const customerReads = state.queries.filter((q) => q.text.includes('FROM customers'));
    expect(customerReads).toHaveLength(1); // only the valid invoice's
    expect(customerReads[0]!.values).toContain(CUST);
    expect(customerReads.some((q) => q.values.includes('null'))).toBe(false);
    expect(state.queries.filter((q) => q.text.includes('UPDATE customer_invoices'))).toHaveLength(1);
  });
});
