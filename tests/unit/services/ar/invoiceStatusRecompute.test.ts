/**
 * `recomputeInvoiceStatus` — status AND `paid_at` derive from the same balance.
 *
 * The helper already collapsed three disagreeing status rules into one. It did
 * not touch `paid_at`, so an invoice could reach status 'paid' with `paid_at`
 * NULL — which is what every aging and statement surface reads to date the
 * settlement. Setting the status and leaving the date is half an answer.
 *
 * The mutation these guard: drop the `paid_at` arm of either CASE and the
 * "stamps"/"clears" tests go red while the status tests stay green.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { recomputeInvoiceStatus } from '@/modules/accounting/services/ar/invoiceStatusRecompute';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const INVOICE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** The statement text with each interpolation collapsed to `?`. */
function sqlText(i = 0): string {
  const parts = mockSql.mock.calls[i]?.[0] as TemplateStringsArray | undefined;
  return (parts ?? ([] as unknown as TemplateStringsArray)).join(' ? ');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([]);
});

describe.each([
  ['customer', 'customer_invoices'],
  ['supplier', 'supplier_invoices'],
] as const)('recomputeInvoiceStatus(%s)', (kind, table) => {
  it(`updates ${table}`, async () => {
    await recomputeInvoiceStatus(COMPANY, kind, INVOICE);
    expect(sqlText()).toContain(table);
  });

  it('stamps paid_at when the balance clears', async () => {
    await recomputeInvoiceStatus(COMPANY, kind, INVOICE);
    // The same threshold that decides status 'paid' must decide the date, or
    // the two disagree on the same row.
    expect(sqlText()).toMatch(/paid_at\s*=\s*CASE/);
    expect(sqlText()).toMatch(/amount_paid >= total_amount - 0\.01[\s\S]*COALESCE\(paid_at, NOW\(\)\)/);
  });

  it('clears paid_at when a payment is undone and the invoice reopens', async () => {
    await recomputeInvoiceStatus(COMPANY, kind, INVOICE);
    expect(sqlText()).toMatch(/ELSE NULL/);
  });

  it('does not re-stamp paid_at on an already-paid invoice', async () => {
    // COALESCE keeps the original settlement date. Overwriting it with NOW()
    // on every recompute would re-date a settlement that happened months ago.
    await recomputeInvoiceStatus(COMPANY, kind, INVOICE);
    expect(sqlText()).toContain('COALESCE(paid_at, NOW())');
  });

  it('is company-scoped', async () => {
    await recomputeInvoiceStatus(COMPANY, kind, INVOICE);
    expect(sqlText()).toContain('company_id');
    expect(mockSql.mock.calls[0]?.slice(1)).toContain(COMPANY);
  });

  it('only touches balance-derived statuses', async () => {
    // 'draft', 'cancelled', 'disputed', 'written_off' are not evidence about
    // payment; a balance figure must not move them.
    await recomputeInvoiceStatus(COMPANY, kind, INVOICE);
    const bound = mockSql.mock.calls[0]?.slice(1) ?? [];
    const derived = bound.find((v): v is string[] => Array.isArray(v));
    expect(derived).toEqual(['approved', 'sent', 'overdue', 'partially_paid', 'paid']);
  });
});

/**
 * `applyLineToInvoice` delegates the status rule instead of carrying a copy.
 *
 * It used to set `status` and `paid_at` inline, with the wrong half of each
 * pair: a bare `NOW()` re-dated a months-old settlement on any further write,
 * and `ELSE paid_at` left a paid date on an invoice that had reopened. Two
 * writers of one rule is the defect class this helper was created to end — it
 * is how three disagreeing status rules arose before it existed.
 *
 * Collapsing it is only correct ON TOP OF the paid_at work in this file:
 * master's `recomputeInvoiceStatus` does not touch `paid_at` at all, so
 * delegating there would leave nothing writing the column.
 */
describe('applyLineToInvoice — one owner of the status rule', () => {
  it('writes the money and delegates status and paid_at', async () => {
    vi.resetModules();
    const recompute = vi.fn();
    const applySql = vi.fn().mockResolvedValue([]);
    vi.doMock('@/lib/neon', () => ({ sql: applySql }));
    vi.doMock('@/modules/accounting/services/ar/invoiceStatusRecompute', () => ({
      recomputeInvoiceStatus: recompute,
    }));

    const { applyLineToInvoice } = await import(
      '@/modules/accounting/services/ar/receiptAllocationLines'
    );
    await applyLineToInvoice(COMPANY, {
      invoiceId: INVOICE, invoiceNumber: 'INV-1', amount: 100,
    } as never);

    const text = (applySql.mock.calls[0]?.[0] as string[]).join('?');
    // Mutation: put the status/paid_at CASE arms back and these go red.
    expect(text).toMatch(/amount_paid\s*=\s*COALESCE\(amount_paid,\s*0\)\s*\+/);
    expect(text).not.toMatch(/status\s*=/);
    expect(text).not.toMatch(/paid_at/);
    expect(recompute).toHaveBeenCalledWith(COMPANY, 'customer', INVOICE);
  });
});
