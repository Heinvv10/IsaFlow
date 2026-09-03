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
 * The AP side still carries its own: `supplierAllocationLines#applyLineToBill`
 * sets `status` inline because it maintains `payment_matched` in the same
 * statement, and this helper knows nothing about that flag. That is a real
 * asymmetry, deliberately left — collapsing it needs either a supplier arm here
 * or the flag kept inline beside a delegated status, which is a design decision
 * on the AP workstream's file rather than a mechanical edit. Blind review was
 * asked and judged the split defensible and pre-existing.
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
const BALANCE_DERIVED = ['approved', 'sent', 'overdue', 'partially_paid', 'paid'];

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
    END
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
      AND status = ANY(${BALANCE_DERIVED})
  `;
}
