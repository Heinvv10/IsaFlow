/**
 * Four-Way Match Service — PRD-05 Phase 4
 *
 * The 4th leg of the match: 3-way matched + payment cleared. This answers
 * whether a supplier invoice's payment leg is settled.
 *
 * IT NO LONGER WRITES THE FLAG. It used to set `supplier_invoices.
 * payment_matched` from a PROJECTION — `amount_paid + allocatedAmount`, taken
 * BEFORE anything moved `amount_paid`. The allocation that followed then
 * applied less than the projection, or (on the path that named no bill)
 * nothing at all, and the bill was left carrying a flag saying it was settled
 * with its whole balance outstanding. That is the mechanism behind bills
 * reading as payment-matched at `amount_paid = 0`.
 *
 * `ar/invoiceStatusRecompute#recomputeInvoiceStatus` is the sole writer: one
 * rule — `amount_paid >= total_amount - 0.01` — applied to the balance AFTER
 * the money moved, alongside `status` and `paid_at`, which derive from the same
 * threshold. Two writers of one condition is how three disagreeing status rules
 * arose in this module before.
 *
 * `payment_matched_but_unapplied` (gl/integrityChecks/documentChecks) is the
 * check that reports any row the old projection left behind.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

const PAYMENT_MATCH_TOLERANCE = 0.01; // R0.01 rounding allowance

/**
 * Whether this supplier invoice's payment leg is settled, RIGHT NOW.
 *
 * `allocatedAmount` is what the caller is about to apply. It is not added to
 * the answer — that addition was the defect — but it is logged, because a
 * caller allocating cash against a bill that is already matched is worth seeing
 * in the request log.
 *
 * Reads and returns; writes nothing, so it is safe to call as often as a caller
 * likes and safe to call before the allocation it describes.
 */
export async function recordPaymentMatch(
  companyId: string,
  invoiceId: string,
  allocatedAmount: number,
): Promise<{ paymentMatched: boolean }> {
  const rows = (await sql`
    SELECT total_amount, amount_paid, payment_matched
    FROM supplier_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) {
    log.warn('recordPaymentMatch: invoice not found', { invoiceId, companyId }, 'four-way-match');
    return { paymentMatched: false };
  }

  const row = rows[0]!;
  const totalAmount = Number(row.total_amount);
  const amountPaid = Number(row.amount_paid);
  // From the BALANCE, not from the balance plus what the caller intends. The
  // same threshold recomputeInvoiceStatus writes the column from, so the answer
  // and the column cannot disagree.
  const paymentMatched = amountPaid >= totalAmount - PAYMENT_MATCH_TOLERANCE;

  log.info('4-way match: payment leg read', {
    invoiceId, totalAmount, amountPaid, allocatedAmount, paymentMatched,
  }, 'four-way-match');

  return { paymentMatched };
}
