/**
 * A recurring-invoice run stops hardcoding CURRENT_DATE + 30: the due date comes from the customer's payment terms
 * (migration 960), and +30 days stays only for a customer whose terms are not set. What is asserted is the due date
 * bound to the customer_invoices INSERT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  template: {} as Record<string, unknown>,
  dueDate: null as string | null,
  invoiceDate: null as string | null,
  sqlCalls: 0,
}));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    state.sqlCalls++;
    if (text.includes('INSERT INTO customer_invoices')) {
      // invoice_date, due_date: the two date strings the run binds.
      const dates = values.filter((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) as string[];
      [state.invoiceDate, state.dueDate] = [dates[0] ?? null, dates[1] ?? null];
    }
    return [{ id: 'inv-1' }];
  }),
  withSavepoint: async (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceApprovalService', () => ({ approveCustomerInvoice: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/recurringInvoiceLock', () => ({ lockRecurringTemplate: vi.fn(async () => state.template) }));
vi.mock('@/modules/accounting/services/core/documentNumberRetry', () => ({
  insertWithReservedNumber: vi.fn(async (_c: string, _t: string, _p: string, _u: string, insert: (n: string) => Promise<string>) => insert('INV-1')),
}));
vi.mock('@/modules/accounting/services/gl/approvalGate', () => ({ evaluateApprovalGate: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({ raiseUnattendedApproval: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceUpstreamAuthors', () => ({ stampUpstreamAuthors: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionDerivation', () => ({ revenueLineDefaults: vi.fn(async () => ({ cc1Id: null })) }));

import { runRecurringInvoice } from '@/modules/accounting/services/ar/recurringInvoiceRun';

function template(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 't1', status: 'active', is_due: true, next_run_date: '2026-11-05', frequency: 'monthly', end_date: null,
    client_id: 'c1', project_id: null, description: 'Retainer', template_name: 'Retainer',
    line_items: [{ description: 'Retainer', quantity: 1, unitPrice: 1000 }],
    subtotal: 1000, tax_rate: 15, tax_amount: 150, total_amount: 1150,
    contact_payment_terms: null, contact_payment_terms_type: null, company_default_terms: JSON.stringify({ days: 30, type: 'invoice_days' }),
    ...over,
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 5, 12, 0, 0)); state.dueDate = null; state.sqlCalls = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('runRecurringInvoice due date', () => {
  it.each([
    ['the company default (30 days from invoice) when the customer has none', {}, '2026-12-05'],
    ['the company default as the company sets it', { company_default_terms: JSON.stringify({ days: 2, type: 'statement_months' }) }, '2027-01-31'],
    ['Immediate is the run date', { contact_payment_terms: 0, contact_payment_terms_type: 'invoice_days' }, '2026-11-05'],
    ['60 days from invoice', { contact_payment_terms: 60, contact_payment_terms_type: 'invoice_days' }, '2027-01-04'],
    ['30 days after statement', { contact_payment_terms: 30, contact_payment_terms_type: 'statement_days' }, '2026-12-30'],
    ['3 months after statement', { contact_payment_terms: 3, contact_payment_terms_type: 'statement_months' }, '2027-02-28'],
    ['a legacy "days" row', { contact_payment_terms: 14, contact_payment_terms_type: 'days' }, '2026-11-19'],
  ])('%s', async (_why, over, due) => {
    state.template = template(over);
    await runRecurringInvoice('co-1', 't1', 'u1');
    expect(state.invoiceDate).toBe('2026-11-05');
    expect(state.dueDate).toBe(due);
  });

  it('runs no statement that reads terms: they ride on the locked template row', async () => {
    state.template = template({});
    await runRecurringInvoice('co-1', 't1', 'u1');
    const selects = vi.mocked((await import('@/lib/neon')).sql).mock.calls
      .filter(([strings]) => (strings as unknown as string[]).join('?').includes('payment_terms'));
    expect(selects).toHaveLength(0);
  });
});
