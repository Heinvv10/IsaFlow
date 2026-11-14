/**
 * The customer mirror of `ap/supplierVoidCredit`: the refusal every cancellation of a customer receipt makes before its
 * first write (Hein, 2026-11-14) — would cancelling these receipts leave a customer's on-account credit below zero on
 * ANY date from the receipts' date onward?
 *
 * Cancelling a receipt removes its unapplied remainder (`total - allocated`, the term `getCustomerOnAccountCredit`
 * sums) from the credit at its own date and every later one. A refund already recorded at a later date was judged
 * against the credit AS AT its date (`planCustomerRefund`), so the test is the running credit from the receipt's date
 * onward — the AR twin of `ap/supplierOnAccountCredit`'s `lowestFromDate`. The all-dates figure alone let a receipt
 * dated after the refund hide a refund left with nothing behind it on its own date (breaker R2-2).
 *
 * Several receipts are judged TOGETHER, by date: each one's remainder leaves the running credit from its own date on,
 * and the cancellation is refused when that leaves the credit below zero on a date it lowered. One receipt: its
 * lowest running credit from its date must cover its remainder. A fully applied receipt and a refund (a negative
 * remainder) lower nothing; a set that lowers nothing takes no lock and is never refused, so a customer already below
 * zero stays correctable that way.
 *
 * Taken under the customer's refund lock, TRIED (`ar/customerCreditLock`), so a refund in flight has committed or the
 * caller is refused as retryable. Residual, as on every customer-side credit read: an APPLICATION of another receipt's
 * remainder takes no customer lock (AR has no credit key), so one committing between this read and the caller's commit
 * is not seen.
 *
 * Callers, each with the receipt row held: `bank/bankAllocationUnwind.unwindOnePayment` (bank reverse, chain reversal,
 * MCP `reverse_bank_allocation` / `_batch` / `_range`, `void_receipt`, a run undo, reallocation) and
 * `unwindBankAllocationApplication` (every receipt on one journal, together); `cancelCustomerPayment` (the receipts
 * screen); `bank/reverseLinesCreditLast.assertLinesKeepCredit` (the range's dry run); reallocation's own ceiling
 * (`bank/bankReallocationCredit`, via `customerVoidCreditShortfall`).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { formatMoney } from '@/lib/money/formatMoney';
import { tryLockCustomerCredit } from './customerCreditLock';
import { ReceiptRefusal, isReceiptRefusal } from './receiptRefusal';

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

/** The credit refusal, told apart from the other receipt refusals so a bulk reversal can retry it last. */
export class CustomerVoidCreditRefusal extends ReceiptRefusal {
  readonly reason = 'credit_ceiling' as const;
}

/** Structural, as `isReceiptRefusal` is. */
export function isCustomerVoidCreditRefusal(err: unknown): err is CustomerVoidCreditRefusal {
  return isReceiptRefusal(err) && (err as { reason?: unknown }).reason === 'credit_ceiling';
}

const cents = (n: number) => Math.round(n * 100);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One customer's running credit (the AR basis: every receipt and refund but cancelled ones; an applied amount counts
 * at its payment's date), before and after cancelling `paymentIds`: the lowest figure from the earliest cancelled
 * receipt's date on, and the lowest figure after the cancellation on the dates it lowers (null when it lowers none).
 */
async function creditAroundCancellation(companyId: string, customerId: string, paymentIds: readonly string[]) {
  const [r] = (await sql`
    WITH pay AS (
      SELECT cp.payment_date AS d, cp.id = ANY(${[...paymentIds]}::UUID[]) AS going,
             cp.total_amount - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0)) AS amount
      FROM customer_payments cp
      LEFT JOIN LATERAL (
        SELECT SUM(cpa.amount_allocated) AS allocated FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id
      ) alloc ON TRUE
      WHERE cp.company_id = ${companyId}::UUID AND cp.client_id = ${customerId}::UUID AND cp.status <> 'cancelled'
    ), by_day AS (
      SELECT d, SUM(amount) AS amount, SUM(amount) FILTER (WHERE going) AS removed FROM pay GROUP BY d
    ), running AS (
      SELECT d, SUM(amount) OVER w AS cum, COALESCE(SUM(removed) OVER w, 0) AS removed
      FROM by_day WINDOW w AS (ORDER BY d)
    ), cancelled_now AS (
      SELECT MIN(d) AS from_date, SUM(GREATEST(amount, 0)) AS lowers FROM pay WHERE going
    )
    SELECT c.name AS customer_name, g.from_date, g.lowers,
           (SELECT MIN(r.cum) FROM running r WHERE r.d >= g.from_date) AS lowest,
           (SELECT MIN(r.cum - r.removed) FROM running r WHERE r.removed > 0) AS lowest_after
    FROM customers c CROSS JOIN cancelled_now g
    WHERE c.id = ${customerId}::UUID AND c.company_id = ${companyId}::UUID`) as DbRow[];
  return {
    customerName: r?.customer_name ? String(r.customer_name) : 'this customer',
    fromDate: r?.from_date == null ? null : fmtDate(r.from_date as string | Date),
    lowers: round2(Number(r?.lowers ?? 0)),
    lowest: round2(Number(r?.lowest ?? 0)),
    lowestAfter: r?.lowest_after == null ? null : round2(Number(r.lowest_after)),
  };
}

/** The first customer whose credit cancelling `paymentIds` would take below zero on some date, or null. */
export async function customerVoidCreditShortfall(
  companyId: string, paymentIds: readonly string[],
): Promise<CustomerVoidCreditShortfall | null> {
  if (paymentIds.length === 0) return null;
  const rows = (await sql`
    SELECT cp.client_id::TEXT AS customer_id,
           SUM(GREATEST(cp.total_amount - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0)), 0)) AS lowers
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
    if (cents(Number(r.lowers ?? 0)) <= 0 || r.customer_id == null) continue;
    const customerId = String(r.customer_id);
    await tryLockCustomerCredit(companyId, customerId);
    const c = await creditAroundCancellation(companyId, customerId, paymentIds); // re-read under the lock
    if (c.lowestAfter == null || cents(c.lowestAfter) >= 0 || c.fromDate == null) continue;
    return { customerId, customerName: c.customerName, lowers: c.lowers, credit: c.lowest, fromDate: c.fromDate };
  }
  return null;
}

/** Refuses (RECEIPT_REFUSED, before any write) cancelling `paymentIds` when it would leave a refund uncovered. */
export async function assertReceiptVoidKeepsCredit(companyId: string, paymentIds: readonly string[]): Promise<void> {
  const s = await customerVoidCreditShortfall(companyId, paymentIds);
  if (!s) return;
  const what = paymentIds.length > 1 ? 'these receipts' : 'this receipt';
  throw new CustomerVoidCreditRefusal(
    `Cancelling ${what} would leave ${s.customerName} owing the company: it takes ${formatMoney(s.lowers)} of `
    + `unapplied cash off the customer's account from ${s.fromDate}, and on some date since then only `
    + `${formatMoney(Math.max(s.credit, 0))} is on account — a refund has already returned the rest. `
    + 'Reverse the refund first, then cancel the receipt.',
  );
}
