/**
 * Four-Way Match Service — PRD-05 Phase 4
 *
 * The 4th leg of the match: 3-way matched + payment cleared.
 * Called from bankAllocationService after a supplier-invoice allocation
 * to flip supplier_invoices.payment_matched when the invoice is fully paid.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

const PAYMENT_MATCH_TOLERANCE = 0.01; // R0.01 rounding allowance

/**
 * Mark a supplier invoice as payment-matched when the cumulative amount paid
 * (existing amount_paid + allocatedAmount) covers the full invoice total.
 *
 * Safe to call multiple times — idempotent once payment_matched=true.
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

  // Already matched — nothing to do
  if (Boolean(row.payment_matched)) {
    return { paymentMatched: true };
  }

  const totalAmount = Number(row.total_amount);
  const amountPaid = Number(row.amount_paid);
  const projectedPaid = amountPaid + allocatedAmount;

  const fullyPaid = projectedPaid >= totalAmount - PAYMENT_MATCH_TOLERANCE;

  if (fullyPaid) {
    await sql`
      UPDATE supplier_invoices
      SET payment_matched = true, payment_matched_at = NOW()
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    `;
    log.info('4-way match: payment_matched set', {
      invoiceId,
      totalAmount,
      amountPaid,
      allocatedAmount,
      projectedPaid,
    }, 'four-way-match');
  }

  return { paymentMatched: fullyPaid };
}
