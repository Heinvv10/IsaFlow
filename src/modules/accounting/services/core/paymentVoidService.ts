/**
 * Void a payment document — a customer receipt (CP) or a supplier payment.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Until now the only way to undo applied cash was `reverse_bank_allocation`,
 * addressed by BANK TRANSACTION. A receipt created by
 * `apply_receipt_to_invoice` against no bank line had no undo at all, and
 * `cancelCustomerPayment` refuses anything that is not `confirmed` — precisely
 * the status a FULLY applied receipt does not have, because
 * `receiptApplicationService.ts` promotes it to `reconciled`. So the better the
 * application worked, the more certainly it could not be undone.
 *
 * ── THE THREE SHAPES ────────────────────────────────────────────────────────
 *
 *   1. It settles a BANK line. `reverseReconciledTransaction` already does the
 *      whole job — unwind, contra, and return the bank line to `imported` — so
 *      this delegates rather than reimplementing it; reimplementing would also
 *      leave the bank line `allocated` against a journal that no longer exists.
 *   2. It has a journal but no bank line. Unwind, then reverse the journal.
 *   3. It has no journal (never posted). Unwind only.
 *
 * ── ORDER IS LOAD-BEARING ───────────────────────────────────────────────────
 *
 * The unwind runs BEFORE the journal is reversed, for the reason in
 * `bankAllocationUnwind.ts`: reversing first returns the credit to the AR/AP
 * control account while the invoice still reads as settled, widening the
 * subledger-to-control gap behind an ordinary-looking reversal.
 *
 * ── SO IS THE LOCK ORDER ────────────────────────────────────────────────────
 *
 * Shape 1 locks two rows. `reverseReconciledTransaction`, which it delegates to,
 * takes the bank line first and reaches the payment afterwards through
 * `unwindOnePayment`'s `UPDATE …_payments`; locking the payment first here is
 * the inverse, so a `void_receipt` on P racing a `reverse_bank_allocation` on
 * the line P settles would hold one row each and deadlock. The line is
 * therefore locked FIRST, off an UNLOCKED read. Order: `bank/.claude.md`.
 *
 * Two consequences of resolving the line before the document, both deliberate.
 * `not_found` is decided from that unlocked peek — a row that does not exist
 * for this tenant cannot appear mid-request, and `loadPayment` answers it again
 * under the lock. And `ambiguous_bank_lines` now outranks `already_cancelled`
 * and `not_applied`, because it is settled before the status is read; a
 * cancelled payment on a two-bank-line journal reports the journal, not the
 * status. Nothing pins that precedence — if a caller comes to depend on the
 * status answer, move the resolution back below `loadPayment` and re-order the
 * locks some other way, do not read this as accidental.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  PaymentPostedDuringVoidError,
  lockCustomerPaymentForUpdate,
  lockSupplierPaymentForUpdate,
} from './paymentLock';
import {
  unwindBankAllocationApplication,
  unwindOnePayment,
} from '../bank/bankAllocationUnwind';
import { reverseReconciledTransaction } from '../bank/bankAllocationService';
import { lockBankTransactionForUpdate } from '../bank/bankTxLock';
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
  | { refusal: 'already_cancelled' }
  | { refusal: 'not_applied'; status: string }
  | { refusal: 'ambiguous_bank_lines'; count: number };

/**
 * The statuses at which a payment's allocations HAVE been added to the
 * invoice's `amount_paid`, and are therefore the statuses it is safe to
 * subtract them at.
 *
 * A `draft` customer payment and a `draft`/`approved` supplier payment already
 * carry allocation ROWS — both create paths insert them up front — but neither
 * has touched `amount_paid`: that happens in `confirmCustomerPayment` and
 * `processSupplierPayment`. Unwinding one would subtract cash the document
 * never applied, out of some OTHER payment's settlement, while the GL control
 * account stands still. Production carries 2 customer and 63 supplier drafts.
 *
 * `voidSupplierPayment` has refused non-`processed` payments for exactly this
 * reason; this path must not be the way around that guard.
 */
const VOIDABLE_STATUSES: Record<PaymentKind, readonly string[]> = {
  customer: ['confirmed', 'reconciled'],
  supplier: ['processed', 'reconciled'],
};

export function isVoidRefusal(v: VoidPaymentResult | VoidRefusal): v is VoidRefusal {
  return 'refusal' in v;
}

interface PaymentRow {
  id: string;
  paymentNumber: string | null;
  status: string;
  journalEntryId: string | null;
}

/**
 * Read the payment back UNDER company_id — the only tenant check there is —
 * holding a row lock for the rest of the transaction.
 *
 * The lock is not decoration. The registry's idempotency lock only serialises
 * calls carrying the SAME key, so two `void_receipt` calls on one receipt with
 * different keys would both read `confirmed`, both read the not-yet-deleted
 * allocation rows, and both subtract from `amount_paid` — twice, on an invoice
 * carrying other receipts' cash, which `GREATEST(...,0)` only floors at zero.
 */
async function loadPayment(
  companyId: string,
  kind: PaymentKind,
  paymentId: string,
): Promise<PaymentRow | null> {
  const row = kind === 'customer'
    ? await lockCustomerPaymentForUpdate(companyId, paymentId)
    : await lockSupplierPaymentForUpdate(companyId, paymentId);
  if (!row) return null;
  return {
    id: String(row.id),
    paymentNumber: row.payment_number == null ? null : String(row.payment_number),
    status: String(row.status),
    journalEntryId: row.gl_journal_entry_id == null ? null : String(row.gl_journal_entry_id),
  };
}

/**
 * The bank lines this journal settles.
 *
 * Matched through `gl_journal_lines`, because `matched_journal_line_id` names a
 * LINE and the payment names an ENTRY. Only a line that is still allocated
 * counts: one already returned to `imported` has nothing left to reverse.
 *
 * Returns ALL of them, not the first, because `reverseReconciledTransaction`
 * reverses the journal once and returns exactly ONE bank line to `imported`.
 * Picking one of several would leave the others `allocated` against a journal
 * that no longer exists — invisible to unreconciled listings and unrecoverable,
 * since a later reversal of that journal throws on `reversedAt`. Ten journals
 * in production carry two bank lines each (bank transfers: one entry, two bank
 * legs), none belonging to a payment document — guessing would be the wrong way
 * to be wrong about money.
 */
async function findBankTransactions(
  companyId: string,
  journalEntryId: string,
): Promise<string[]> {
  const rows = (await sql`
    SELECT bt.id
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
    WHERE bt.company_id = ${companyId}::UUID
      AND jl.journal_entry_id = ${journalEntryId}::UUID
      AND bt.status IN ('allocated', 'matched', 'reconciled')
    ORDER BY bt.transaction_date, bt.id`) as DbRow[];
  return rows.map((r) => String(r.id));
}

/** The payment's journal id WITHOUT its row lock — only to resolve the bank
 * line so THAT can be locked first (see the header). Nothing is decided from
 * it: status and number are re-read under the lock, a moved journal id is
 * caught at the call site. `undefined` = no such row for this tenant. */
async function peekPaymentJournal(
  companyId: string, kind: PaymentKind, paymentId: string,
): Promise<string | null | undefined> {
  const rows = (kind === 'customer'
    ? await sql`SELECT gl_journal_entry_id FROM customer_payments
        WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`
    : await sql`SELECT gl_journal_entry_id FROM supplier_payments
        WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  if (rows.length === 0) return undefined;
  const id = rows[0]!.gl_journal_entry_id;
  return id == null ? null : String(id);
}

export async function voidPaymentDocument(
  companyId: string,
  kind: PaymentKind,
  paymentId: string,
  userId: string,
  opts?: PostingActorOpts & { reversalDate?: string },
): Promise<VoidPaymentResult | VoidRefusal> {
  // LOCK ORDER: bank line, then payment — see the header.
  const peekedJournalId = await peekPaymentJournal(companyId, kind, paymentId);
  if (peekedJournalId === undefined) return { refusal: 'not_found' };

  const bankLines = peekedJournalId
    ? await findBankTransactions(companyId, peekedJournalId)
    : [];
  if (bankLines.length > 1) {
    return { refusal: 'ambiguous_bank_lines', count: bankLines.length };
  }
  const bankTransactionId = bankLines[0] ?? null;
  // A no-op re-lock for `reverseReconciledTransaction` below — one statement,
  // and it fixes the order for the pair.
  if (bankTransactionId) await lockBankTransactionForUpdate(companyId, bankTransactionId);

  const payment = await loadPayment(companyId, kind, paymentId);
  if (!payment) return { refusal: 'not_found' };
  if (payment.status === 'cancelled') return { refusal: 'already_cancelled' };
  if (!VOIDABLE_STATUSES[kind].includes(payment.status)) {
    return { refusal: 'not_applied', status: payment.status };
  }
  if (payment.journalEntryId !== peekedJournalId) {
    // `gl_journal_entry_id` is written once, when the payment posts, and never
    // reassigned — so the row posted between the peek and the lock and the line
    // locked above is the wrong one. Nothing has been written, and the retry
    // succeeds, so this is a TYPED retryable refusal like every other one on
    // the settlement paths rather than a bare `Error` a REST route would 500.
    throw new PaymentPostedDuringVoidError(paymentId);
  }

  // Shape 1: the bank path already unwinds, posts the contra AND resets the
  // bank line. Doing any of that here as well would double-reverse.
  if (bankTransactionId) {
    // The counts come back from the bank path rather than being reported as
    // zero: this branch does the MOST work, and an agent told "0 invoices
    // reopened" after a successful void concludes nothing was undone and
    // re-applies the receipt. The agent IS the display.
    const unwoundViaBank = await reverseReconciledTransaction(
      companyId, bankTransactionId, userId, opts,
    );
    log.info('Voided payment document via its bank allocation', {
      companyId, kind, paymentId, bankTransactionId,
      invoicesReopened: unwoundViaBank.invoicesReopened,
      amountUnapplied: unwoundViaBank.amountUnapplied,
    }, 'accounting');
    return {
      paymentId: payment.id,
      paymentNumber: payment.paymentNumber,
      kind,
      invoicesReopened: unwoundViaBank.invoicesReopened,
      amountUnapplied: unwoundViaBank.amountUnapplied,
      journalEntryId: payment.journalEntryId,
      bankTransactionId,
    };
  }

  // Shapes 2 and 3. Unwind FIRST — see the header.
  //
  // When there IS a journal, unwind EVERY payment hanging off it, not just this
  // one. Reversing the journal takes the cash back out of the ledger for all of
  // them, so unwinding only the named payment would leave any sibling reading as
  // settled with its posting reversed — the subledger-to-control gap this
  // function exists to avoid, arrived at from the other direction. Nothing
  // writes two payments against one journal today and no unique index forbids
  // it, so this is a guard against a shape the schema permits rather than a
  // live defect.
  // The unwind and the contra share ONE savepoint of their own (K-021). Without
  // it the pair is atomic only because today's single caller happens to hold a
  // savepoint and never catches: a REST route over this function, or any caller
  // that turned the throw into a 4xx, would commit the unwind with the journal
  // still standing — the invoice reopened and the cash still posted. Owning the
  // boundary here makes that independent of who calls it.
  const unwound = await withSavepoint('void_payment_unwind', async () => {
    const result = payment.journalEntryId
      ? await unwindBankAllocationApplication(companyId, payment.journalEntryId)
      : await unwindOnePayment(companyId, kind, payment.id);

    if (payment.journalEntryId) {
      const { reverseJournalEntry } = await import('../gl/journalEntryService');
      // No catch: a closed period or an already-reversed entry must reach the
      // savepoint above — and through it the caller's. Flattening it into a
      // returned error would RELEASE both and commit the unwind.
      await reverseJournalEntry(companyId, payment.journalEntryId, userId, opts);
    }
    return result;
  });

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
