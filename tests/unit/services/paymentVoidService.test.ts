/**
 * voidPaymentDocument — the three shapes a payment can be in.
 *
 * What is worth pinning:
 *
 *  - a BANK-backed payment delegates wholly to reverseReconciledTransaction.
 *    Unwinding or reversing here as well would double-reverse, and skipping the
 *    delegation would leave the bank line `allocated` against a journal that no
 *    longer exists.
 *  - the unwind runs BEFORE the journal is reversed. The other order returns
 *    the credit to the AR/AP control account while the invoice still reads as
 *    settled, which widens the subledger-to-control gap behind an
 *    ordinary-looking reversal.
 *  - a payment with no journal is unwound and cancelled, and NOTHING is
 *    reversed — there is no journal to reverse.
 *  - the payment is read back under company_id, and an already-cancelled one is
 *    refused rather than voided twice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  // The unwind and the contra share a savepoint; with `sql` mocked there is no
  // transaction to hold one, so run the block straight through.
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/modules/accounting/services/core/paymentLock', async () => {
  // importOriginal, not a hand-written stub: the refusal CLASSES are part of
  // this module's contract and a stub that omits one turns a typed refusal into
  // a mock-resolution error that looks nothing like the production failure.
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/core/paymentLock')>(
    '@/modules/accounting/services/core/paymentLock',
  );
  return { ...actual, lockCustomerPaymentForUpdate: vi.fn(), lockSupplierPaymentForUpdate: vi.fn() };
});
vi.mock('@/modules/accounting/services/bank/bankAllocationUnwind', () => ({
  unwindOnePayment: vi.fn(),
  unwindBankAllocationApplication: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({
  lockBankTransactionForUpdate: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  reverseJournalEntry: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  lockCustomerPaymentForUpdate,
  lockSupplierPaymentForUpdate,
} from '@/modules/accounting/services/core/paymentLock';
import {
  unwindOnePayment,
  unwindBankAllocationApplication,
} from '@/modules/accounting/services/bank/bankAllocationUnwind';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { lockBankTransactionForUpdate } from '@/modules/accounting/services/bank/bankTxLock';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import {
  isVoidRefusal,
  voidPaymentDocument,
  type VoidPaymentResult,
} from '@/modules/accounting/services/core/paymentVoidService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const JE = '88888888-8888-4888-8888-888888888888';
const BANK_TX = '99999999-9999-4999-8999-999999999999';

/**
 * Set the locked payment row, then queue what each subsequent `sql` call
 * returns. The payment is read through the LOCK helper, not bare `sql` — the
 * lock is what stops two concurrent voids subtracting the same allocation
 * twice, so a test that bypassed it would not be exercising the real path.
 */
function given(payment: Record<string, unknown> | null, ...results: unknown[][]): void {
  vi.mocked(lockCustomerPaymentForUpdate).mockResolvedValue(payment as never);
  vi.mocked(lockSupplierPaymentForUpdate).mockResolvedValue(payment as never);
  const m = vi.mocked(sql);
  // The UNLOCKED journal-id peek is now the first statement: it resolves the
  // bank line so THAT can be locked before the payment. See the lock-order
  // section in paymentVoidService.ts. It agrees with the locked read by
  // construction here; the mismatch case has its own test below.
  m.mockResolvedValueOnce((payment === null
    ? []
    : [{ gl_journal_entry_id: payment.gl_journal_entry_id ?? null }]) as never);
  // The bank-line lookup now runs BEFORE the status refusals, because the line
  // has to be locked before the payment. A test that only asserts a refusal
  // supplies no results, so stand in an empty bank-line set for it.
  const queued = results.length === 0 && payment?.gl_journal_entry_id ? [[]] : results;
  for (const rows of queued) m.mockResolvedValueOnce(rows as never);
}

const paymentRow = (over: Record<string, unknown> = {}) => ({
  id: PAYMENT,
  payment_number: 'CP-2025-00024',
  status: 'confirmed',
  gl_journal_entry_id: JE,
  ...over,
});

function asResult(v: VoidPaymentResult | { refusal: string }): VoidPaymentResult {
  expect(isVoidRefusal(v as never)).toBe(false);
  return v as VoidPaymentResult;
}

describe('voidPaymentDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears CALLS, not implementations — a mockRejectedValue set
    // by one test would otherwise leak into the next, and an UNCONSUMED
    // mockResolvedValueOnce stays queued and is handed to the next test's first
    // `sql` call, silently offsetting every result after it.
    vi.mocked(sql).mockReset();
    vi.mocked(unwindOnePayment).mockResolvedValue({ invoicesReopened: 2, amountUnapplied: 1500 });
    vi.mocked(unwindBankAllocationApplication).mockResolvedValue({
      invoicesReopened: 2, amountUnapplied: 1500, paymentsCancelled: 1,
    });
    vi.mocked(reverseJournalEntry).mockResolvedValue(undefined as never);
    vi.mocked(reverseReconciledTransaction).mockResolvedValue({
      invoicesReopened: 3, amountUnapplied: 2750.25, paymentsCancelled: 1,
    } as never);
  });

  it('refuses a payment that is not in the company', async () => {
    given(null);
    const r = await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER);
    expect(r).toEqual({ refusal: 'not_found' });
    expect(unwindOnePayment).not.toHaveBeenCalled();
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('refuses an already-cancelled document rather than voiding it twice', async () => {
    given(paymentRow({ status: 'cancelled' }));
    const r = await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER);
    expect(r).toEqual({ refusal: 'already_cancelled' });
    expect(unwindOnePayment).not.toHaveBeenCalled();
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('delegates wholly to the bank path when the payment settled a bank line', async () => {
    given(paymentRow(), [{ id: BANK_TX }]);
    const r = asResult(await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER));

    expect(reverseReconciledTransaction).toHaveBeenCalledWith(COMPANY, BANK_TX, USER, undefined);
    // The bank path owns the unwind and the contra. Doing either here as well
    // would reverse the journal twice.
    expect(unwindOnePayment).not.toHaveBeenCalled();
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    expect(r.bankTransactionId).toBe(BANK_TX);
  });

  // MEDIUM-1 follow-through (round 8). This function locks TWO rows nobody else
  // owns together, and `reverseReconciledTransaction` — the very function it
  // delegates to — takes the bank line FIRST and reaches the payment afterwards
  // through `unwindOnePayment`'s `UPDATE …_payments`. Locking the payment first
  // was the inverse order, so a `void_receipt` on P racing a
  // `reverse_bank_allocation` on the line P settles held one row each and
  // deadlocked (40P01 → 500). Canonical order: `bank/.claude.md`.
  it('locks the bank line BEFORE the payment — the canonical order', async () => {
    const order: string[] = [];
    vi.mocked(lockBankTransactionForUpdate).mockImplementation(async () => {
      order.push('bank'); return null;
    });
    vi.mocked(lockCustomerPaymentForUpdate).mockImplementation(async () => {
      order.push('payment'); return paymentRow() as never;
    });
    const m = vi.mocked(sql);
    m.mockResolvedValueOnce([{ gl_journal_entry_id: JE }] as never);
    m.mockResolvedValueOnce([{ id: BANK_TX }] as never);

    await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER);
    expect(order).toEqual(['bank', 'payment']);
    expect(lockBankTransactionForUpdate).toHaveBeenCalledWith(COMPANY, BANK_TX);
  });

  // The peek is UNLOCKED, so the journal id it read can move before the lock is
  // taken — and then the line locked above is the wrong one. `gl_journal_entry_id`
  // is written once when a payment posts and never reassigned, so this is the
  // posting race, not a normal state. Nothing has been written; it must throw
  // rather than proceed against a line it never locked.
  it('refuses when the payment posts between the unlocked peek and the lock', async () => {
    const OTHER_JE = '55555555-5555-4555-8555-555555555555';
    vi.mocked(lockCustomerPaymentForUpdate)
      .mockResolvedValue(paymentRow({ gl_journal_entry_id: OTHER_JE }) as never);
    const m = vi.mocked(sql);
    m.mockResolvedValueOnce([{ gl_journal_entry_id: null }] as never);  // peek: not posted yet

    const err = await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER)
      .then(() => null, (e: unknown) => e);
    expect((err as Error).message).toMatch(/posted while this void was being prepared/i);
    // TYPED, not a bare Error: `safeErrorText` surfaces a message only for a
    // code on `REFUSAL_CODES`, and an agent handed the generic fallback retries
    // the call it was just refused.
    expect(err).toMatchObject({ code: 'PAYMENT_POSTED_DURING_VOID' });
    expect(unwindOnePayment).not.toHaveBeenCalled();
    expect(unwindBankAllocationApplication).not.toHaveBeenCalled();
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('reports the counts the BANK path actually unwound, never zero', async () => {
    // This branch does the most work. Answering "0 invoices reopened" after a
    // successful void tells an agent nothing was undone, and it re-applies the
    // receipt.
    given(paymentRow(), [{ id: BANK_TX }]);
    const r = asResult(await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER));
    expect(r.invoicesReopened).toBe(3);
    expect(r.amountUnapplied).toBe(2750.25);
  });

  it('REFUSES a draft receipt — its allocations were never added to amount_paid', async () => {
    // A draft carries allocation ROWS but has not touched amount_paid, which
    // only moves in confirmCustomerPayment. Unwinding one subtracts cash the
    // document never applied, taking it out of some OTHER receipt's settlement
    // while the GL control account stands still. Production carries 2 of these.
    given(paymentRow({ status: 'draft' }));
    const r = await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER);
    expect(r).toEqual({ refusal: 'not_applied', status: 'draft' });
    expect(unwindOnePayment).not.toHaveBeenCalled();
    expect(unwindBankAllocationApplication).not.toHaveBeenCalled();
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('REFUSES an approved (not yet processed) supplier payment', async () => {
    // The AP mirror: amount_paid moves in processSupplierPayment, not before.
    // Production carries 63 draft supplier payments.
    for (const status of ['draft', 'approved']) {
      vi.clearAllMocks();
      given(paymentRow({ status }));
      const r = await voidPaymentDocument(COMPANY, 'supplier', PAYMENT, USER);
      expect(r).toEqual({ refusal: 'not_applied', status });
      expect(unwindOnePayment).not.toHaveBeenCalled();
    }
  });

  it('ACCEPTS the statuses at which the cash HAS been applied', async () => {
    for (const [kind, status] of [
      ['customer', 'confirmed'], ['customer', 'reconciled'],
      ['supplier', 'processed'], ['supplier', 'reconciled'],
    ] as const) {
      vi.clearAllMocks();
      vi.mocked(unwindOnePayment).mockResolvedValue({ invoicesReopened: 1, amountUnapplied: 10 });
      given(paymentRow({ status, gl_journal_entry_id: null }));
      const r = await voidPaymentDocument(COMPANY, kind, PAYMENT, USER);
      expect(isVoidRefusal(r as never)).toBe(false);
      expect(unwindOnePayment).toHaveBeenCalledWith(COMPANY, kind, PAYMENT);
    }
  });

  it('reads the payment under a ROW LOCK, not a bare SELECT', async () => {
    // Two concurrent voids with different idempotency keys are not serialised
    // by the registry; only the row lock stops both subtracting the same
    // allocation from amount_paid.
    given(paymentRow(), []);
    await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER);
    expect(lockCustomerPaymentForUpdate).toHaveBeenCalledWith(COMPANY, PAYMENT);

    vi.clearAllMocks();
    vi.mocked(unwindBankAllocationApplication).mockResolvedValue({
      invoicesReopened: 0, amountUnapplied: 0, paymentsCancelled: 0,
    });
    vi.mocked(reverseJournalEntry).mockResolvedValue(undefined as never);
    given(paymentRow(), []);
    await voidPaymentDocument(COMPANY, 'supplier', PAYMENT, USER);
    expect(lockSupplierPaymentForUpdate).toHaveBeenCalledWith(COMPANY, PAYMENT);
  });

  it('unwinds BEFORE reversing when there is a journal but no bank line', async () => {
    given(paymentRow(), []);
    const order: string[] = [];
    vi.mocked(unwindBankAllocationApplication).mockImplementation(async () => {
      order.push('unwind');
      return { invoicesReopened: 2, amountUnapplied: 1500, paymentsCancelled: 1 };
    });
    vi.mocked(reverseJournalEntry).mockImplementation(async () => {
      order.push('reverse');
      return undefined as never;
    });

    const r = asResult(await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER));

    expect(order).toEqual(['unwind', 'reverse']);
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
    expect(r.invoicesReopened).toBe(2);
    expect(r.amountUnapplied).toBe(1500);
    expect(r.journalEntryId).toBe(JE);
    expect(r.bankTransactionId).toBeNull();
  });

  it('unwinds EVERY payment on the journal it is about to reverse', async () => {
    // Reversing the journal takes the cash out of the ledger for every payment
    // hanging off it. Unwinding only the named one would leave a sibling reading
    // as settled with its posting reversed.
    given(paymentRow(), []);
    await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER);
    expect(unwindBankAllocationApplication).toHaveBeenCalledWith(COMPANY, JE);
    expect(unwindOnePayment).not.toHaveBeenCalled();
  });

  it('REFUSES rather than guess when the journal settles two bank lines', async () => {
    // reverseReconciledTransaction reverses the journal once and returns ONE
    // bank line to imported. Picking one of two would strand the other against
    // a journal that no longer exists — unrecoverable, since reversing it again
    // throws on reversedAt.
    given(paymentRow(), [{ id: BANK_TX }, { id: 'other-bank-tx' }]);
    const r = await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER);
    expect(r).toEqual({ refusal: 'ambiguous_bank_lines', count: 2 });
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
    expect(unwindBankAllocationApplication).not.toHaveBeenCalled();
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('unwinds and reverses NOTHING when the payment was never posted', async () => {
    given(paymentRow({ gl_journal_entry_id: null, status: 'confirmed' }));
    const r = asResult(await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER));

    expect(unwindOnePayment).toHaveBeenCalledWith(COMPANY, 'customer', PAYMENT);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
    expect(r.journalEntryId).toBeNull();
  });

  it('lets a reversal failure propagate rather than committing a half-void', async () => {
    given(paymentRow(), []);
    vi.mocked(reverseJournalEntry).mockRejectedValue(new Error('period is closed'));
    await expect(voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER))
      .rejects.toThrow('period is closed');
  });

  it('unwinds the SUPPLIER side when asked for one', async () => {
    // 'processed', not 'confirmed': the AP subledger's applied state has its own
    // name, and 'confirmed' is a customer-side status the guard rightly refuses.
    given(paymentRow({ gl_journal_entry_id: null, status: 'processed' }));
    const r = asResult(await voidPaymentDocument(COMPANY, 'supplier', PAYMENT, USER));
    expect(unwindOnePayment).toHaveBeenCalledWith(COMPANY, 'supplier', PAYMENT);
    expect(r.kind).toBe('supplier');
  });

  it('forwards the posting stamp and reversal date to the reversal', async () => {
    given(paymentRow(), []);
    const opts = { postingAgent: 'mcp:void_receipt:v1', reversalDate: '2026-03-01' };
    await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER, opts as never);
    expect(reverseJournalEntry).toHaveBeenCalledWith(COMPANY, JE, USER, opts);
  });
});
