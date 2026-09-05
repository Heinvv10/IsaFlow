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
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankAllocationUnwind', () => ({
  unwindOnePayment: vi.fn(),
  unwindBankAllocationApplication: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  reverseJournalEntry: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  unwindOnePayment,
  unwindBankAllocationApplication,
} from '@/modules/accounting/services/bank/bankAllocationUnwind';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
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

/** Queue the rows each `sql` call returns, in call order. */
function queue(...results: unknown[][]): void {
  const m = vi.mocked(sql);
  for (const rows of results) m.mockResolvedValueOnce(rows as never);
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
    // by one test would otherwise leak into the next.
    vi.mocked(unwindOnePayment).mockResolvedValue({ invoicesReopened: 2, amountUnapplied: 1500 });
    vi.mocked(unwindBankAllocationApplication).mockResolvedValue({
      invoicesReopened: 2, amountUnapplied: 1500, paymentsCancelled: 1,
    });
    vi.mocked(reverseJournalEntry).mockResolvedValue(undefined as never);
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined as never);
  });

  it('refuses a payment that is not in the company', async () => {
    queue([]);
    const r = await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER);
    expect(r).toEqual({ refusal: 'not_found' });
    expect(unwindOnePayment).not.toHaveBeenCalled();
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('refuses an already-cancelled document rather than voiding it twice', async () => {
    queue([paymentRow({ status: 'cancelled' })]);
    const r = await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER);
    expect(r).toEqual({ refusal: 'already_cancelled' });
    expect(unwindOnePayment).not.toHaveBeenCalled();
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('delegates wholly to the bank path when the payment settled a bank line', async () => {
    queue([paymentRow()], [{ id: BANK_TX }]);
    const r = asResult(await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER));

    expect(reverseReconciledTransaction).toHaveBeenCalledWith(COMPANY, BANK_TX, USER, undefined);
    // The bank path owns the unwind and the contra. Doing either here as well
    // would reverse the journal twice.
    expect(unwindOnePayment).not.toHaveBeenCalled();
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    expect(r.bankTransactionId).toBe(BANK_TX);
  });

  it('unwinds BEFORE reversing when there is a journal but no bank line', async () => {
    queue([paymentRow()], []);
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
    queue([paymentRow()], []);
    await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER);
    expect(unwindBankAllocationApplication).toHaveBeenCalledWith(COMPANY, JE);
    expect(unwindOnePayment).not.toHaveBeenCalled();
  });

  it('unwinds and reverses NOTHING when the payment was never posted', async () => {
    queue([paymentRow({ gl_journal_entry_id: null })]);
    const r = asResult(await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER));

    expect(unwindOnePayment).toHaveBeenCalledWith(COMPANY, 'customer', PAYMENT);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
    expect(r.journalEntryId).toBeNull();
  });

  it('lets a reversal failure propagate rather than committing a half-void', async () => {
    queue([paymentRow()], []);
    vi.mocked(reverseJournalEntry).mockRejectedValue(new Error('period is closed'));
    await expect(voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER))
      .rejects.toThrow('period is closed');
  });

  it('unwinds the SUPPLIER side when asked for one', async () => {
    queue([paymentRow({ gl_journal_entry_id: null })]);
    const r = asResult(await voidPaymentDocument(COMPANY, 'supplier', PAYMENT, USER));
    expect(unwindOnePayment).toHaveBeenCalledWith(COMPANY, 'supplier', PAYMENT);
    expect(r.kind).toBe('supplier');
  });

  it('forwards the posting stamp and reversal date to the reversal', async () => {
    queue([paymentRow()], []);
    const opts = { postingAgent: 'mcp:void_receipt:v1', reversalDate: '2026-03-01' };
    await voidPaymentDocument(COMPANY, 'customer', PAYMENT, USER, opts as never);
    expect(reverseJournalEntry).toHaveBeenCalledWith(COMPANY, JE, USER, opts);
  });
});
