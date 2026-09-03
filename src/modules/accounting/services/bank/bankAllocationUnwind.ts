/**
 * Unwinding the SUBLEDGER half of a bank allocation, on reversal.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `reverseReconciledTransaction` did exactly two things: post the contra via
 * `reverseJournalEntry`, and reset `bank_transactions` to `imported`. It has no
 * reference to `amount_paid`, to any allocation table, or to a payment
 * document. That was harmless for as long as the bank allocation path applied
 * nothing — which was itself the bug.
 *
 * Now that a line naming an `invoice_id` settles that invoice, reversing one
 * without this would leave:
 *
 *   · the invoice still carrying `amount_paid`, still reading as settled
 *   · its journal reversed, so the credit is back on the AR/AP control account
 *   · the bank line back at `imported`, free to be allocated a second time
 *   · the payment document at `reconciled` — and `cancelCustomerPayment`
 *     refuses anything that is not `confirmed`
 *     (`customerPaymentAllocationService.ts:110`), so there is NO existing
 *     service that can clean it up
 *
 * The last two compound: `receiptApplicationService.ts:135` promotes a FULLY
 * applied receipt to `reconciled` and leaves a partly applied one `confirmed`,
 * so the dead end appears precisely where the allocation worked best.
 *
 * And the first one manufactures the exact defect this programme exists to
 * find. Returning the credit to the control account while the invoice keeps
 * `amount_paid` widens the subledger-to-control gap by the reversed amount,
 * with an ordinary-looking reversal journal behind it — indistinguishable from
 * routine correction activity.
 *
 * ── ORDER IS LOAD-BEARING ───────────────────────────────────────────────────
 *
 * This runs BEFORE `reverseJournalEntry`, not after. If the unwind throws, no
 * contra has been posted and the caller is unchanged; the other order leaves a
 * posted contra with the application still in place, which is the broken state
 * above. Both halves are inside the caller's transaction, so a later failure
 * takes the whole thing with it.
 *
 * ── RELATIVE, AND DERIVED ───────────────────────────────────────────────────
 *
 * `amount_paid` moves by `- x` in SQL. An absolute value recomputed in JS is a
 * lost update, and it is a live open item on this codebase already —
 * `bank-match-confirm.ts` writes the column absolutely and dated settlement
 * exceeds it on 40 production invoices by R124,960.37.
 *
 * `status`, `paid_at`, `payment_matched` and `payment_matched_at` are NOT set
 * here. `recomputeInvoiceStatus` owns all four, derived from the balance this
 * function just moved. This file briefly wrote `payment_matched` inline and was
 * therefore a third writer of it — and an unguarded one, missing the helper's
 * `status = ANY(BALANCE_DERIVED)` filter, so it could re-flag a cancelled bill
 * that the guarded recompute then refuses to correct. Two writers of one rule
 * is how three disagreeing status rules arose; three is not an improvement.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';

export interface BankAllocationUnwindResult {
  /** Invoices whose `amount_paid` was reduced. */
  invoicesReopened: number;
  /** Total taken back off those invoices. */
  amountUnapplied: number;
  /** Payment documents cancelled. */
  paymentsCancelled: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reverse every invoice application made by the payment documents hanging off
 * this journal entry, and cancel those documents.
 *
 * Payments are found by `gl_journal_entry_id`, which both apply paths already
 * stamp, so nothing new has to be recorded to make a reversal exact.
 *
 * The payment document is CANCELLED rather than left behind. Leaving it at
 * `reconciled` with no allocation rows produces a receipt no read tool can
 * explain and no service can clean up; cancelling states plainly that the cash
 * it represented is no longer applied to anything, which is true — its journal
 * is about to be reversed.
 */
export async function unwindBankAllocationApplication(
  companyId: string,
  journalEntryId: string,
): Promise<BankAllocationUnwindResult> {
  let invoicesReopened = 0;
  let amountUnapplied = 0;
  let paymentsCancelled = 0;

  for (const kind of ['customer', 'supplier'] as const) {
    const payments = (kind === 'customer'
      ? await sql`
          SELECT id FROM customer_payments
          WHERE company_id = ${companyId}::UUID
            AND gl_journal_entry_id = ${journalEntryId}::UUID
            AND status <> 'cancelled'`
      : await sql`
          SELECT id FROM supplier_payments
          WHERE company_id = ${companyId}::UUID
            AND gl_journal_entry_id = ${journalEntryId}::UUID
            AND status <> 'cancelled'`) as DbRow[];

    for (const p of payments) {
      const paymentId = String(p.id);

      // Scoped through the payment, which was company-scoped above. Neither
      // allocation table carries a company_id of its own, so reaching them by
      // id alone would be an unscoped read.
      //
      // customer_payment_allocations vs payment_allocations is not a typo:
      // `supplier_payment_allocations` (migration 201) holds zero rows in dev
      // and in production and is read by nothing, while every supplier service
      // uses `payment_allocations`.
      const allocs = (kind === 'customer'
        ? await sql`
            SELECT invoice_id, amount_allocated FROM customer_payment_allocations
            WHERE payment_id = ${paymentId}::UUID`
        : await sql`
            SELECT invoice_id, amount_allocated FROM payment_allocations
            WHERE payment_id = ${paymentId}::UUID`) as DbRow[];

      for (const a of allocs) {
        const invoiceId = String(a.invoice_id);
        const amt = round2(Number(a.amount_allocated ?? 0));
        if (amt <= 0) continue;

        if (kind === 'customer') {
          // GREATEST(...,0): never drive the column negative. A concurrent
          // correction may already have taken the balance down, and a negative
          // amount_paid reads as a credit nobody authorised.
          await sql`
            UPDATE customer_invoices
            SET amount_paid = GREATEST(COALESCE(amount_paid, 0) - ${amt}, 0),
                updated_at = NOW()
            WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID`;
        } else {
          // Money only, like the customer arm. This used to derive
          // `payment_matched` inline as well — a THIRD writer of that column,
          // and an UNGUARDED one: it carried no `status = ANY(BALANCE_DERIVED)`
          // filter, so it would re-flag a cancelled or written-off bill, and
          // the guarded recompute below then no-ops on exactly those statuses
          // and cannot correct it. Blind review found it.
          await sql`
            UPDATE supplier_invoices
            SET amount_paid = GREATEST(COALESCE(amount_paid, 0) - ${amt}, 0),
                updated_at = NOW()
            WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID`;
        }

        // Owns status, paid_at AND payment_matched, from the balance just moved.
        await recomputeInvoiceStatus(companyId, kind, invoiceId);
        invoicesReopened += 1;
        amountUnapplied = round2(amountUnapplied + amt);
      }

      if (kind === 'customer') {
        await sql`DELETE FROM customer_payment_allocations WHERE payment_id = ${paymentId}::UUID`;
        await sql`
          UPDATE customer_payments SET status = 'cancelled', updated_at = NOW()
          WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`;
      } else {
        await sql`DELETE FROM payment_allocations WHERE payment_id = ${paymentId}::UUID`;
        await sql`
          UPDATE supplier_payments SET status = 'cancelled', updated_at = NOW()
          WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`;
      }
      paymentsCancelled += 1;
    }
  }

  if (paymentsCancelled > 0) {
    log.info('Unwound bank allocation application before journal reversal', {
      companyId, journalEntryId, invoicesReopened, amountUnapplied, paymentsCancelled,
    }, 'accounting');
  }
  return { invoicesReopened, amountUnapplied, paymentsCancelled };
}
