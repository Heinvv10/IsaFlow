/**
 * #1106: the recurring-invoice run advanced next_run_date with setMonth(+1/+3), which overflows a short month
 * (31 Oct -> 1 Dec, skipping November). The run must claim the schedule at the clamped date. Everything around the
 * date arithmetic is stubbed; what is asserted is the `next_run_date` the run writes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const written = vi.hoisted(() => ({ nextRunDate: null as string | null, template: {} as Record<string, unknown> }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('UPDATE recurring_invoices')) {
      written.nextRunDate = String(values.find((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)));
    }
    return [{ id: 'inv-1' }];
  }),
  withSavepoint: async (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceApprovalService', () => ({ approveCustomerInvoice: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/recurringInvoiceLock', () => ({ lockRecurringTemplate: vi.fn(async () => written.template) }));
vi.mock('@/modules/accounting/services/core/documentNumberRetry', () => ({
  insertWithReservedNumber: vi.fn(async (_c: string, _t: string, _p: string, _u: string, insert: (n: string) => Promise<string>) => insert('INV-1')),
}));
vi.mock('@/modules/accounting/services/gl/approvalGate', () => ({ evaluateApprovalGate: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({ raiseUnattendedApproval: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceUpstreamAuthors', () => ({ stampUpstreamAuthors: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionDerivation', () => ({ revenueLineDefaults: vi.fn(async () => ({ cc1Id: null })) }));

import { runRecurringInvoice } from '@/modules/accounting/services/ar/recurringInvoiceRun';

function template(nextRunDate: string, frequency: string): Record<string, unknown> {
  return {
    id: 't1', status: 'active', is_due: true, next_run_date: nextRunDate, frequency, end_date: null,
    client_id: 'c1', project_id: null, description: 'Retainer', template_name: 'Retainer',
    line_items: [{ description: 'Retainer', quantity: 1, unitPrice: 1000 }],
    subtotal: 1000, tax_rate: 15, tax_amount: 150, total_amount: 1150,
  };
}

beforeEach(() => { written.nextRunDate = null; });

describe('runRecurringInvoice advances next_run_date by calendar month, clamped to month end', () => {
  it.each([
    ['monthly', '2026-10-31', '2026-11-30'],
    ['monthly', '2026-11-30', '2026-12-31'],
    ['monthly', '2027-01-29', '2027-02-28'],
    ['monthly', '2027-01-30', '2027-02-28'],
    ['monthly', '2027-01-31', '2027-02-28'],
    ['monthly', '2028-01-31', '2028-02-29'],
    ['quarterly', '2026-08-31', '2026-11-30'],
    ['quarterly', '2026-11-30', '2027-02-28'],
    ['annually', '2028-02-29', '2029-02-28'],
  ])('%s from %s writes %s', async (frequency, from, to) => {
    written.template = template(from, frequency);
    await runRecurringInvoice('co', 't1', 'u1');
    expect(written.nextRunDate).toBe(to);
  });
});
