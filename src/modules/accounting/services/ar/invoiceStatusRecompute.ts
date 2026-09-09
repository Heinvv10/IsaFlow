/**
 * Recompute an invoice's status from its balance, in ONE place.
 *
 * Credit-note approve, cancel and apply each moved `amount_paid` and each had a
 * different idea of what that meant for `status`: approve never recomputed at
 * all (an invoice fully covered by a note kept 'approved' while amount_paid
 * >= total_amount), cancel recomputed but hard-coded 'approved' whenever the
 * balance cleared (discarding 'sent', 'overdue' and 'paid'), and the supplier
 * branch recomputed nothing. Approve and cancel were therefore not inverses.
 *
 * The rule is deliberately conservative: it only moves a row between the three
 * balance-derived states. A status that is not balance-derived — 'draft',
 * 'cancelled', 'disputed', 'written_off' — is left exactly as it is, because
 * a payment figure is not evidence about those.
 *
 * `paid_at` moves with the status, from the SAME threshold, because every
 * aging and statement surface reads it to DATE the settlement. Setting status
 * 'paid' and leaving `paid_at` NULL is half an answer, and it is the half the
 * reports cannot use. Two rules make it safe:
 *
 *   · COALESCE(paid_at, NOW()) — an invoice that is already paid keeps its
 *     original date. A bare NOW() would re-date a months-old settlement on
 *     every unrelated recompute.
 *   · ELSE NULL — an invoice that drops out of 'paid' (a reversal, a cancelled
 *     credit note) loses the date too, because it is no longer settled. A
 *     stale paid_at on an open invoice is worse than none: it reads as
 *     evidence of a settlement that has been undone.
 *
 * `paid_at` MEANS "when the balance reached zero", NOT "when cash arrived".
 * A credit note that fully offsets an invoice sets it, because the invoice IS
 * settled — and `status` has always read 'paid' in that case, so dating the
 * same fact adds no conflation that was not already there. Which INSTRUMENT
 * settled it is answered by the allocation rows and the credit note itself,
 * both of which survive; it is not a question this column was ever able to
 * answer. Blind review raised the conflation and this is the answer to it.
 *
 * WHO ELSE WRITES THESE TWO COLUMNS. On the AR side, nobody: the inline copy
 * in `receiptAllocationLines#applyLineToInvoice` — a bare `NOW()` that re-dated
 * an already-settled invoice, and an `ELSE paid_at` that kept a paid date on a
 * REOPENED one — was collapsed into this helper. `applyLineToInvoice` now
 * writes `amount_paid` and delegates here.
 *
 * The AP side is now collapsed too. `payment_matched` derives from the SAME
 * threshold as `status = 'paid'` — `amount_paid >= total_amount - 0.01` — so it
 * is a third column on one condition and belongs with the other two.
 * `applyLineToBill` writes the money and delegates all three.
 *
 * That flag reads as a procurement concept and is not one. `recordPaymentMatch`
 * lives in `capture/fourWayMatchService.ts`, but it has exactly ONE production
 * caller — the bank allocation path — and it fires only when
 * `projectedPaid >= totalAmount - tolerance`. A settlement test behind a
 * procurement filename. The name cost one session an afternoon and nearly cost
 * a remediation that would have "corrected" correct data.
 *
 * REMAINING DIVERGENCE. `fourWayMatchService#recordPaymentMatch` is still a
 * second writer of `payment_matched`, and its basis differs subtly: it projects
 * `amount_paid + allocatedAmount` BEFORE the write, where this derives from the
 * balance AFTER it. Converging them is a behaviour question in `capture/`, not
 * a move — so it is named here rather than done, the way the AR divergence was
 * named here until it could be closed.
 */

import { sql } from '@/lib/neon';

export type InvoiceKind = 'customer' | 'supplier';

/**
 * `open` is the state a partly-unpaid invoice returns to. Customer invoices use
 * 'approved' for that; supplier invoices use the same word, and both tables
 * carry 'partially_paid' and 'paid'.
 *
 * Statuses NOT touched: anything outside this set is preserved by the CASE.
 */
export const BALANCE_DERIVED = ['approved', 'sent', 'overdue', 'partially_paid', 'paid'];

export async function recomputeInvoiceStatus(
  companyId: string,
  kind: InvoiceKind,
  invoiceId: string,
): Promise<void> {
  // 'sent' and 'overdue' are preserved while a balance remains: both mean
  // "unpaid and communicated", which staying unpaid does not contradict.
  // Collapsing them to 'approved' is what lost dunning state before.
  if (kind === 'customer') {
    await sql`
      UPDATE customer_invoices SET status = CASE
        WHEN amount_paid >= total_amount - 0.01 THEN 'paid'
        WHEN amount_paid > 0.01 THEN 'partially_paid'
        WHEN status IN ('partially_paid', 'paid') THEN 'approved'
        ELSE status
      END,
      paid_at = CASE
        WHEN amount_paid >= total_amount - 0.01 THEN COALESCE(paid_at, NOW())
        ELSE NULL
      END
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
        AND status = ANY(${BALANCE_DERIVED})
    `;
    return;
  }
  // `payment_matched` is the THIRD column on this one threshold, so it belongs
  // here rather than in a caller's copy. It is a settlement flag despite living
  // behind a procurement-sounding name — see the docstring above.
  await sql`
    UPDATE supplier_invoices SET status = CASE
      WHEN amount_paid >= total_amount - 0.01 THEN 'paid'
      WHEN amount_paid > 0.01 THEN 'partially_paid'
      WHEN status IN ('partially_paid', 'paid') THEN 'approved'
      ELSE status
    END,
    paid_at = CASE
      WHEN amount_paid >= total_amount - 0.01 THEN COALESCE(paid_at, NOW())
      ELSE NULL
    END,
    payment_matched = (amount_paid >= total_amount - 0.01),
    payment_matched_at = CASE
      WHEN amount_paid >= total_amount - 0.01 THEN COALESCE(payment_matched_at, NOW())
      ELSE NULL
    END
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
      AND status = ANY(${BALANCE_DERIVED})
  `;
}
