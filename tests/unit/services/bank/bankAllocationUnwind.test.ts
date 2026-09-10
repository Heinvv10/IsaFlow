/**
 * Reversing a bank allocation takes the money back off the invoice.
 *
 * Before this, `reverseReconciledTransaction` posted the contra and reset the
 * bank row and touched nothing else — no `amount_paid`, no allocation row, no
 * payment document. Harmless while the bank path applied nothing; once a line
 * can settle an invoice it leaves the credit back on the control account with
 * the invoice still reading as settled, which is the subledger-to-control gap
 * this whole programme is measuring, manufactured by a reversal that looks
 * like routine correction.
 *
 * Every test names the mutation it catches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, recomputeInvoiceStatus } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  recomputeInvoiceStatus: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/invoiceStatusRecompute', () => ({ recomputeInvoiceStatus }));

import { unwindBankAllocationApplication } from '@/modules/accounting/services/bank/bankAllocationUnwind';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const JOURNAL = 'jjjjjjjj-jjjj-jjjj-jjjj-jjjjjjjjjjjj';
const PAYMENT = 'pppppppp-pppp-pppp-pppp-pppppppppppp';
const INVOICE = 'iiiiiiii-iiii-iiii-iiii-iiiiiiiiiiii';

function textOf(i: number): string {
  const parts = sqlMock.mock.calls[i]?.[0] as TemplateStringsArray | undefined;
  return (parts ?? ([] as unknown as TemplateStringsArray)).join(' ? ');
}
function allText(): string {
  return sqlMock.mock.calls.map((_, i) => textOf(i)).join('\n---\n');
}

/** Customer payment found, one allocation, then everything else empty. */
function customerWithOneAllocation(amount = '750.00') {
  sqlMock.mockReset();
  sqlMock
    .mockResolvedValueOnce([{ id: PAYMENT }])                                   // customer_payments
    .mockResolvedValueOnce([{ invoice_id: INVOICE, amount_allocated: amount }]) // its allocations
    .mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([]);
  recomputeInvoiceStatus.mockResolvedValue(undefined);
});

describe('unwindBankAllocationApplication', () => {
  it('takes the applied amount back off the invoice', async () => {
    customerWithOneAllocation();
    const r = await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(r.invoicesReopened).toBe(1);
    expect(r.amountUnapplied).toBeCloseTo(750, 2);
    expect(r.paymentsCancelled).toBe(1);
  });

  it('subtracts RELATIVELY, never writing a figure computed in JS', async () => {
    // Mutation: replace `amount_paid - $n` with an absolute value and this goes
    // red. The absolute form is a lost update, and it is already a live defect
    // elsewhere in this codebase (bank-match-confirm, 40 invoices, R124,960.37).
    customerWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(allText()).toMatch(/amount_paid\s*=\s*GREATEST\(COALESCE\(amount_paid,\s*0\)\s*-/);
  });

  it('never drives amount_paid negative', async () => {
    // Mutation: drop GREATEST(...,0) — a double reversal takes the invoice to a
    // negative paid figure, i.e. a credit nobody authorised.
    customerWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(allText()).toContain('GREATEST(');
  });

  it('lets recomputeInvoiceStatus own status and paid_at', async () => {
    // Two writers of the status rule is how three disagreeing versions of it
    // arose. This function must move the balance and nothing else.
    customerWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(recomputeInvoiceStatus).toHaveBeenCalledWith(COMPANY, 'customer', INVOICE);
    // Per STATEMENT, not across the joined log: a later `UPDATE
    // customer_payments SET status = 'cancelled'` is a different table and
    // must not make this assertion pass or fail.
    const invoiceWrites = sqlMock.mock.calls
      .map((_, i) => textOf(i))
      .filter((t) => t.includes('UPDATE customer_invoices'));
    expect(invoiceWrites).toHaveLength(1);
    expect(invoiceWrites[0]).not.toMatch(/status\s*=/);
    expect(invoiceWrites[0]).not.toMatch(/paid_at/);
  });

  it('deletes the allocation rows so nothing can be double-counted later', async () => {
    customerWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(allText()).toContain('DELETE FROM customer_payment_allocations');
  });

  it('cancels the payment document rather than stranding it', async () => {
    // A fully applied receipt is promoted to `reconciled`, and
    // cancelCustomerPayment refuses anything that is not `confirmed` — so a
    // payment left behind here is unreachable by every existing service.
    customerWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(allText()).toMatch(/UPDATE customer_payments SET status = 'cancelled'/);
  });

  it('finds payments by journal entry, company-scoped, ignoring cancelled ones', async () => {
    await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(textOf(0)).toContain('gl_journal_entry_id');
    expect(textOf(0)).toContain('company_id');
    // Re-reversing must not unwind a second time.
    expect(textOf(0)).toMatch(/status\s*<>\s*'cancelled'/);
  });

  it('reads allocations through the payment, which has no company_id of its own', async () => {
    customerWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(textOf(1)).toContain('payment_id');
  });

  it('is a no-op for a journal that settled nothing', async () => {
    const r = await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(r).toEqual({ invoicesReopened: 0, amountUnapplied: 0, paymentsCancelled: 0 });
    expect(recomputeInvoiceStatus).not.toHaveBeenCalled();
  });

  it('skips a zero-value allocation without counting it', async () => {
    sqlMock.mockReset();
    sqlMock
      .mockResolvedValueOnce([{ id: PAYMENT }])
      .mockResolvedValueOnce([{ invoice_id: INVOICE, amount_allocated: '0.00' }])
      .mockResolvedValue([]);
    const r = await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(r.invoicesReopened).toBe(0);
    expect(r.amountUnapplied).toBe(0);
  });
});

describe('unwindOnePayment — canonical lock order', () => {
  // `reverseReconciledTransaction` is the one caller that does not already hold
  // the payment, so the order INSIDE this function is the order that path
  // takes: it must reach `customer_payments` before `customer_invoices`, or it
  // inverts `planReceiptApplication` (payment then invoices) on the same pair.
  it('cancels the payment before it touches the invoices', async () => {
    customerWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);

    const texts = sqlMock.mock.calls.map((_, i) => textOf(i));
    const flip = texts.findIndex((t) => /UPDATE customer_payments\s+SET status = 'cancelled'/i.test(t));
    const invoice = texts.findIndex((t) => /UPDATE customer_invoices/i.test(t));
    expect(flip, 'the payment must be cancelled').toBeGreaterThanOrEqual(0);
    expect(invoice, 'the invoice must be rolled back').toBeGreaterThanOrEqual(0);
    expect(flip).toBeLessThan(invoice);
  });

  it('reads the allocations in a deterministic invoice order', async () => {
    // Without ORDER BY, two unwinds sharing two invoices can take them in
    // opposite orders and deadlock.
    customerWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);

    const allocRead = sqlMock.mock.calls
      .map((_, i) => textOf(i))
      .find((t) => /FROM customer_payment_allocations/i.test(t));
    expect(allocRead).toMatch(/ORDER BY invoice_id/i);
  });

  it('deletes the allocation rows only after the loop that reverses them', async () => {
    customerWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);

    const texts = sqlMock.mock.calls.map((_, i) => textOf(i));
    const invoice = texts.findIndex((t) => /UPDATE customer_invoices/i.test(t));
    const del = texts.findIndex((t) => /DELETE FROM customer_payment_allocations/i.test(t));
    expect(del).toBeGreaterThan(invoice);
  });
});

describe('unwindBankAllocationApplication — supplier side', () => {
  function supplierWithOneAllocation() {
    sqlMock.mockReset();
    sqlMock
      .mockResolvedValueOnce([])                                                  // customer_payments: none
      .mockResolvedValueOnce([{ id: PAYMENT }])                                   // supplier_payments
      .mockResolvedValueOnce([{ invoice_id: INVOICE, amount_allocated: '400.00' }])
      .mockResolvedValue([]);
  }

  it('uses payment_allocations, not the dead supplier_payment_allocations table', async () => {
    // supplier_payment_allocations (migration 201) holds ZERO rows in dev and
    // production and is read by nothing; every supplier service uses
    // payment_allocations. Writing the dead one makes the unwind invisible.
    supplierWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(allText()).toContain('FROM payment_allocations');
    expect(allText()).not.toContain('supplier_payment_allocations');
  });

  it('does NOT write payment_matched itself — the helper owns it', async () => {
    // This file briefly derived the flag inline and was therefore a THIRD
    // writer of it, and an unguarded one: it had no
    // `status = ANY(BALANCE_DERIVED)` filter, so it would re-flag a cancelled
    // bill that the guarded recompute then refuses to correct. Mutation:
    // restore the inline arm and this goes red.
    supplierWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);
    const invoiceWrites = sqlMock.mock.calls
      .map((_, i) => textOf(i))
      .filter((t) => t.includes('UPDATE supplier_invoices'));
    expect(invoiceWrites).toHaveLength(1);
    expect(invoiceWrites[0]).not.toMatch(/payment_matched/);
    expect(invoiceWrites[0]).not.toMatch(/status\s*=/);
    expect(invoiceWrites[0]).not.toMatch(/paid_at/);
  });

  it('delegates the settlement columns to recomputeInvoiceStatus', async () => {
    // The flag still has to move — it is just not this file's job. Mutation:
    // drop the recompute call and the flag, status and paid_at all go stale
    // after a reversal.
    supplierWithOneAllocation();
    await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(recomputeInvoiceStatus).toHaveBeenCalledWith(COMPANY, 'supplier', INVOICE);
  });

  it('cancels the supplier payment document', async () => {
    supplierWithOneAllocation();
    const r = await unwindBankAllocationApplication(COMPANY, JOURNAL);
    expect(allText()).toMatch(/UPDATE supplier_payments SET status = 'cancelled'/);
    expect(r.paymentsCancelled).toBe(1);
  });
});

/**
 * The ORDER of the two halves of a reversal.
 *
 * The unwind must complete BEFORE the contra is posted. If the unwind throws
 * after a contra exists, the books are left with the credit back on the control
 * account AND the invoice still reading as settled — the exact state this
 * function was written to prevent, reached by the function itself.
 */
describe('reverseReconciledTransaction — ordering', () => {
  it('unwinds the application before posting the contra', async () => {
    const order: string[] = [];
    vi.resetModules();

    vi.doMock('@/modules/accounting/services/bank/bankAllocationUnwind', () => ({
      unwindBankAllocationApplication: vi.fn(async () => {
        order.push('unwind');
        return { invoicesReopened: 1, amountUnapplied: 100, paymentsCancelled: 1 };
      }),
    }));
    vi.doMock('@/modules/accounting/services/gl/journalEntryService', () => ({
      reverseJournalEntry: vi.fn(async () => { order.push('reverse'); }),
      resolveReversalDate: vi.fn(async () => '2026-08-04'),
    }));
    vi.doMock('@/modules/accounting/services/gl/periodStatusService', () => ({
      getPeriodStatusForDate: vi.fn(async () => 'open'),
    }));
    vi.doMock('@/modules/accounting/services/bank/bankTxLock', () => ({
      lockBankTransactionForUpdate: vi.fn(async () => ({
        id: 'tx-1', status: 'allocated', matched_journal_line_id: 'jl-1',
      })),
    }));
    vi.doMock('@/lib/neon', () => ({
      sql: vi.fn(async () => [{ journal_entry_id: JOURNAL, entry_date: '2026-08-04' }]),
      withTransaction: vi.fn(async (fn: (t: unknown) => Promise<void>) => fn(vi.fn())),
      withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
    }));

    const { reverseReconciledTransaction } = await import(
      '@/modules/accounting/services/bank/bankAllocationService'
    );
    await reverseReconciledTransaction(COMPANY, 'tx-1', 'user-1');

    // Mutation: move the unwind call below reverseJournalEntry and this flips.
    expect(order).toEqual(['unwind', 'reverse']);
  });
});
