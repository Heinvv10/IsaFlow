/**
 * A recurring-invoice run stops hardcoding CURRENT_DATE + 30: the due date comes from the customer's payment terms
 * (migration 958), and +30 days stays only for a customer whose terms are not set. What is asserted is the due date
 * bound to the customer_invoices INSERT.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  terms: { payment_terms: null, payment_terms_type: null } as { payment_terms: number | null; payment_terms_type: string | null },
  dueDate: null as string | null,
  customerScope: null as unknown[] | null,
}));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM (SELECT 1)')) { state.customerScope = values; return [{ today: '2026-11-05', ...state.terms }]; }
    if (text.includes('INSERT INTO customer_invoices')) {
      state.dueDate = String(values.find((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)));
    }
    return [{ id: 'inv-1' }];
  }),
  withSavepoint: async (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceApprovalService', () => ({ approveCustomerInvoice: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/recurringInvoiceLock', () => ({
  lockRecurringTemplate: vi.fn(async () => ({
    id: 't1', status: 'active', is_due: true, next_run_date: '2026-11-05', frequency: 'monthly', end_date: null,
    client_id: 'c1', project_id: null, description: 'Retainer', template_name: 'Retainer',
    line_items: [{ description: 'Retainer', quantity: 1, unitPrice: 1000 }],
    subtotal: 1000, tax_rate: 15, tax_amount: 150, total_amount: 1150,
  })),
}));
vi.mock('@/modules/accounting/services/core/documentNumberRetry', () => ({
  insertWithReservedNumber: vi.fn(async (_c: string, _t: string, _p: string, _u: string, insert: (n: string) => Promise<string>) => insert('INV-1')),
}));
vi.mock('@/modules/accounting/services/gl/approvalGate', () => ({ evaluateApprovalGate: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({ raiseUnattendedApproval: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceUpstreamAuthors', () => ({ stampUpstreamAuthors: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionDerivation', () => ({ revenueLineDefaults: vi.fn(async () => ({ cc1Id: null })) }));

import { runRecurringInvoice } from '@/modules/accounting/services/ar/recurringInvoiceRun';

beforeEach(() => { state.dueDate = null; state.customerScope = null; });

describe('runRecurringInvoice due date', () => {
  it.each([
    ['not set keeps +30 days', null, null, '2026-12-05'],
    ['Immediate is the run date', 0, 'invoice_days', '2026-11-05'],
    ['60 days from invoice', 60, 'invoice_days', '2027-01-04'],
    ['30 days after statement', 30, 'statement_days', '2026-12-30'],
    ['3 months after statement', 3, 'statement_months', '2027-02-28'],
  ])('%s', async (_why, days, type, due) => {
    state.terms = { payment_terms: days, payment_terms_type: type };
    await runRecurringInvoice('co-1', 't1', 'u1');
    expect(state.dueDate).toBe(due);
  });

  it('reads the customer inside the company', async () => {
    await runRecurringInvoice('co-1', 't1', 'u1');
    expect(state.customerScope).toEqual(['c1', 'co-1']);
  });
});
