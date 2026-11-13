/**
 * The customer mirror of `ap/supplierVoidCredit`, as a READ, for the reallocation path ONLY: would cancelling these
 * customer receipts leave a customer's on-account credit below zero on ANY date from the receipts' date onward?
 *
 * Cancelling a receipt removes its unapplied remainder (`total - allocated`, the term `getCustomerOnAccountCredit`
 * sums) from the credit at its own date and every later one. A refund already recorded at a later date was judged
 * against the credit AS AT its date (`planCustomerRefund`), so the test is the LOWEST running credit from the
 * receipt's date onward — the AR twin of `ap/supplierOnAccountCredit`'s `lowestFromDate`. The all-dates figure alone
 * let a receipt dated after the refund hide a refund left with nothing behind it on its own date (breaker R2-2).
 *
 * Taken under the customer's refund lock (`core/paymentLock.lockContactForRefund`, the row a refund locks before it
 * reads the same figure), so a refund in flight has committed or waits. Residual, as on every customer-side credit
 * read: an APPLICATION of another receipt's remainder takes no customer lock (AR has no credit key), so one committing
 * between this read and the caller's commit is not seen.
 *
 * reverse_bank_allocation and void_receipt do not ask it (a separate, reported gap); keep them out until that is decided.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { lockContactForRefund } from '../core/paymentLock';

export interface CustomerVoidCreditShortfall {
  customerId: string;
  customerName: string;
  /** The unapplied cash the cancellation takes off the customer's account. */
  lowers: number;
  /** The lowest running credit from `fromDate` onward, before the cancellation. */
  credit: number;
  /** The earliest cancelled receipt's date: the credit is judged from here on. */
  fromDate: string;
}

const cents = (n: number) => Math.round(n * 100);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The customer's lowest running on-account credit at `fromDate` or any later document date (the AR basis: every
 * receipt and refund but cancelled ones; an applied amount counts at its payment's date).
 */
export async function customerLowestCreditFrom(
  companyId: string, customerId: string, fromDate: string,
): Promise<{ lowest: number; customerName: string }> {
  const [r] = (await sql`
    WITH by_day AS (
      SELECT cp.payment_date AS d,
             SUM(cp.total_amount - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0))) AS amount
      FROM customer_payments cp
      LEFT JOIN LATERAL (
        SELECT SUM(cpa.amount_allocated) AS allocated FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id
      ) alloc ON TRUE
      WHERE cp.company_id = ${companyId}::UUID AND cp.client_id = ${customerId}::UUID AND cp.status <> 'cancelled'
      GROUP BY cp.payment_date
    ), running AS (
      SELECT d, SUM(amount) OVER (ORDER BY d) AS cum FROM by_day
    )
    SELECT c.name AS customer_name,
           COALESCE((SELECT SUM(b.amount) FROM by_day b WHERE b.d <= ${fromDate}::DATE), 0) AS at_from,
           (SELECT MIN(r.cum) FROM running r WHERE r.d > ${fromDate}::DATE) AS lowest_later
    FROM customers c WHERE c.id = ${customerId}::UUID AND c.company_id = ${companyId}::UUID`) as DbRow[];
  const atFrom = Number(r?.at_from ?? 0);
  const later = r?.lowest_later == null ? atFrom : Number(r.lowest_later);
  return { lowest: round2(Math.min(atFrom, later)), customerName: r?.customer_name ? String(r.customer_name) : 'this customer' };
}

/** The first customer whose credit cancelling `paymentIds` would take below zero on some date, or null. */
export async function customerVoidCreditShortfall(
  companyId: string, paymentIds: readonly string[],
): Promise<CustomerVoidCreditShortfall | null> {
  if (paymentIds.length === 0) return null;
  const rows = (await sql`
    SELECT cp.client_id::TEXT AS customer_id, MIN(cp.payment_date) AS from_date,
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
    const fromDate = fmtDate(r.from_date as string | Date);
    await lockContactForRefund(companyId, 'customer', customerId);
    const { lowest, customerName } = await customerLowestCreditFrom(companyId, customerId, fromDate);
    if (cents(lowest) - cents(lowers) >= 0) continue;
    return { customerId, customerName, lowers: round2(lowers), credit: lowest, fromDate };
  }
  return null;
}
