/**
 * The customer mirror of `ap/supplierVoidCredit.assertVoidKeepsCredit`, as a READ: would cancelling these customer
 * receipts take a customer's on-account credit below zero?
 *
 * Cancelling a receipt removes its unapplied remainder (`total - allocated`, the term `getCustomerOnAccountCredit`
 * sums) from the customer's on-account credit. When a refund has already paid that remainder back out, the credit
 * goes below zero: a refund with nothing behind it, the company owed by nobody it can name. Judged on every date (the
 * credit as at the far future), as the supplier check is.
 *
 * Taken under the customer's refund lock (`core/paymentLock.lockContactForRefund`, the row a refund locks before it
 * reads the same figure), so a refund in flight has committed or waits. Residual, as on every customer-side credit
 * read: an APPLICATION of another receipt's remainder takes no customer lock (AR has no credit key), so one committing
 * between this read and the caller's commit is not seen.
 *
 * CALLED ONLY by the reallocation path (`bank/bankReallocationService`), which refuses on a shortfall. reverse_bank_allocation
 * and void_receipt do not ask it yet (a separate, reported gap); keep them out until that is decided.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockContactForRefund } from '../core/paymentLock';
import { getCustomerOnAccountCredit } from './customerRefundDocument';

export interface CustomerVoidCreditShortfall {
  customerId: string;
  customerName: string;
  /** The unapplied cash the cancellation takes off the customer's account. */
  lowers: number;
  /** The customer's on-account credit before it (every date). */
  credit: number;
}

const cents = (n: number) => Math.round(n * 100);
const EVERY_DATE = '9999-12-31';

/** The first customer whose credit cancelling `paymentIds` would take below zero, or null. Locks each customer it judges. */
export async function customerVoidCreditShortfall(
  companyId: string, paymentIds: readonly string[],
): Promise<CustomerVoidCreditShortfall | null> {
  if (paymentIds.length === 0) return null;
  const rows = (await sql`
    SELECT cp.client_id::TEXT AS customer_id,
           SUM(cp.total_amount - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0))) AS lowers
    FROM customer_payments cp
    LEFT JOIN LATERAL (
      SELECT SUM(cpa.amount_allocated) AS allocated FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id
    ) alloc ON TRUE
    WHERE cp.company_id = ${companyId}::UUID
      AND cp.id = ANY(${[...paymentIds]}::UUID[])
      AND cp.status <> 'cancelled'
    GROUP BY cp.client_id
    ORDER BY cp.client_id`) as DbRow[];
  for (const r of rows) {
    const lowers = Number(r.lowers ?? 0);
    if (cents(lowers) <= 0 || r.customer_id == null) continue;
    const customerId = String(r.customer_id);
    await lockContactForRefund(companyId, 'customer', customerId);
    const { credit, customerName } = await getCustomerOnAccountCredit(companyId, customerId, EVERY_DATE);
    if (cents(credit) - cents(lowers) >= 0) continue;
    return { customerId, customerName, lowers: Math.round(lowers * 100) / 100, credit };
  }
  return null;
}
