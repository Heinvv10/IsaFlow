/**
 * Void a payment document — a customer receipt (CP) or a supplier payment.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Until now the only way to undo applied cash was `reverse_bank_allocation`,
 * which is addressed by BANK TRANSACTION. A receipt created by
 * `apply_receipt_to_invoice` against no bank line had no undo at all, and
 * `cancelCustomerPayment` refuses anything that is not `confirmed`
 * (`customerPaymentAllocationService.ts:110`) — which is precisely the status a
 * FULLY applied receipt does not have, because `receiptApplicationService.ts`
 * promotes it to `reconciled`. So the better the application worked, the more
 * certainly it could not be undone.
 *
 * ── THE THREE SHAPES ────────────────────────────────────────────────────────
 *
 * A payment reaches this function in one of three states, and each needs a
 * different amount of work:
 *
 *   1. It settles a BANK line. `reverseReconciledTransaction` already does the
 *      whole job — unwind, contra, and return the bank line to `imported` — and
 *      is the tested path, so this delegates rather than reimplementing it.
 *      Reimplementing it would also leave the bank line `allocated` against a
 *      journal that no longer exists.
 *   2. It has a journal but no bank line. Unwind, then reverse the journal.
 *   3. It has no journal (never posted). Unwind only; there is nothing to
 *      reverse.
 *
 * ── ORDER IS LOAD-BEARING ───────────────────────────────────────────────────
 *
 * The unwind runs BEFORE the journal is reversed, for the reason spelled out in
 * `bankAllocationUnwind.ts`: reversing first returns the credit to the AR/AP
 * control account while the invoice still reads as settled, which widens the
 * subledger-to-control gap behind an ordinary-looking reversal. If the unwind
 * throws, nothing has been posted.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { unwindOnePayment } from '../bank/bankAllocationUnwind';
import { reverseReconciledTransaction } from '../bank/bankAllocationService';
import type { PostingActorOpts } from '../gl/journalEntryMeta';

export type PaymentKind = 'customer' | 'supplier';

export interface VoidPaymentResult {
  paymentId: string;
  paymentNumber: string | null;
  kind: PaymentKind;
  /** Invoices whose `amount_paid` was reduced. */
  invoicesReopened: number;
  /** Total taken back off those invoices. */
  amountUnapplied: number;
  /** The journal that was reversed, when there was one. */
  journalEntryId: string | null;
  /** The bank line returned to `imported`, when the payment settled one. */
  bankTransactionId: string | null;
}

/** Why a void was refused. Distinguished so the caller can word each one. */
export type VoidRefusal =
  | { refusal: 'not_found' }
  | { refusal: 'already_cancelled' };

export function isVoidRefusal(v: VoidPaymentResult | VoidRefusal): v is VoidRefusal {
  return 'refusal' in v;
}

interface PaymentRow {
  id: string;
  paymentNumber: string | null;
  status: string;
  journalEntryId: string | null;
}

/** Read the payment back UNDER company_id — the only tenant check there is. */
async function loadPayment(
  companyId: string,
  kind: PaymentKind,
  paymentId: string,
): Promise<PaymentRow | null> {
  const rows = (kind === 'customer'
    ? await sql`
        SELECT id, payment_number, status, gl_journal_entry_id
        FROM customer_payments
        WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`
    : await sql`
        SELECT id, payment_number, status, gl_journal_entry_id
        FROM supplier_payments
        WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    paymentNumber: row.payment_number == null ? null : String(row.payment_number),
    status: String(row.status),
    journalEntryId: row.gl_journal_entry_id == null ? null : String(row.gl_journal_entry_id),
  };
}

/**
 * The bank line this journal settles, if any.
 *
 * Matched through `gl_journal_lines`, because `matched_journal_line_id` names a
 * LINE and the payment names an ENTRY. Only a line that is still allocated
 * counts: one already returned to `imported` has nothing left to reverse.
 */
async function findBankTransaction(
  companyId: string,
  journalEntryId: string,
): Promise<string | null> {
  const rows = (await sql`
    SELECT bt.id
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
    WHERE bt.company_id = ${companyId}::UUID
      AND jl.journal_entry_id = ${journalEntryId}::UUID
      AND bt.status IN ('allocated', 'matched', 'reconciled')
    LIMIT 1`) as DbRow[];
  return rows[0] ? String(rows[0].id) : null;
}

export async function voidPaymentDocument(
  companyId: string,
  kind: PaymentKind,
  paymentId: string,
  userId: string,
  opts?: PostingActorOpts & { reversalDate?: string },
): Promise<VoidPaymentResult | VoidRefusal> {
  const payment = await loadPayment(companyId, kind, paymentId);
  if (!payment) return { refusal: 'not_found' };
  if (payment.status === 'cancelled') return { refusal: 'already_cancelled' };

  const bankTransactionId = payment.journalEntryId
    ? await findBankTransaction(companyId, payment.journalEntryId)
    : null;

  // Shape 1: the bank path already unwinds, posts the contra AND resets the
  // bank line. Doing any of that here as well would double-reverse.
  if (bankTransactionId) {
    await reverseReconciledTransaction(companyId, bankTransactionId, userId, opts);
    log.info('Voided payment document via its bank allocation', {
      companyId, kind, paymentId, bankTransactionId,
    }, 'accounting');
    return {
      paymentId: payment.id,
      paymentNumber: payment.paymentNumber,
      kind,
      // reverseReconciledTransaction owns the unwind and does not report its
      // counts. Re-reading them here would be a second source of truth for a
      // number the caller only displays.
      invoicesReopened: 0,
      amountUnapplied: 0,
      journalEntryId: payment.journalEntryId,
      bankTransactionId,
    };
  }

  // Shapes 2 and 3. Unwind FIRST — see the header.
  const unwound = await unwindOnePayment(companyId, kind, payment.id);

  if (payment.journalEntryId) {
    const { reverseJournalEntry } = await import('../gl/journalEntryService');
    // No catch: a closed period or an already-reversed entry must reach the
    // caller's savepoint. Flattening it into a returned error would RELEASE the
    // savepoint and commit the unwind above with the journal still standing —
    // the invoice reopened and the cash still posted.
    await reverseJournalEntry(companyId, payment.journalEntryId, userId, opts);
  }

  log.info('Voided payment document', {
    companyId, kind, paymentId,
    journalEntryId: payment.journalEntryId,
    invoicesReopened: unwound.invoicesReopened,
    amountUnapplied: unwound.amountUnapplied,
  }, 'accounting');

  return {
    paymentId: payment.id,
    paymentNumber: payment.paymentNumber,
    kind,
    invoicesReopened: unwound.invoicesReopened,
    amountUnapplied: unwound.amountUnapplied,
    journalEntryId: payment.journalEntryId,
    bankTransactionId: null,
  };
}
