/**
 * One customer's running on-account credit by date, and the ONE rule every write that removes unapplied receipt cash
 * is judged by (Hein, 2026-11-14): **the running credit must not end below zero on any date the write lowers.**
 *
 * The basis is the AR one (`getCustomerOnAccountCredit`): every receipt and refund but cancelled ones, each counting
 * its unapplied remainder (`total - allocated`, allocations capped at a positive total) at its payment date. A write
 * removes cash from given rows — a cancellation the row's whole remainder, an application the amount applied — and
 * that cash leaves the running credit from the row's date onward. A refund's remainder is negative, so cancelling it
 * RAISES the credit. A date is "lowered" when the cumulative removal up to it is above zero; dates the write leaves
 * alone (or raises) are never the reason it is refused, so a customer already below zero somewhere stays correctable
 * by writes that do not lower that date — and is refused any write that would deepen it.
 *
 * The SQL reads the per-day figures; the decision is `judgeCreditDays`, pure, so the bulk back-fill population can
 * apply the very same rule to removals it is only simulating.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

/** Cash a write takes off one receipt's remainder: `amount` when given (an application), else the whole remainder. */
export interface CreditRemoval { paymentId: string; amount?: number }

export interface CreditDay {
  d: string;
  /** Every live row's remainder on this date. */
  amount: number;
  /** What the write removes on this date (negative for a refund it cancels). */
  removed: number;
  /** The positive part of `removed`, row by row: the cash the write takes off. */
  lowers: number;
  /** The remainders of the rows the write does NOT touch: what a concurrent writer could change. */
  others: number;
}

export interface CreditJudgement {
  /** The earliest date the write lowers, or null when it lowers none. */
  fromDate: string | null;
  lowers: number;
  /** The lowest running credit from `fromDate` on, before the write. */
  lowest: number;
  /** The lowest running credit after the write, over the dates it lowers; null when it lowers none. */
  lowestAfter: number | null;
}

const cents = (n: number) => Math.round(n * 100);

/** The per-day figures for `customerId`, with `removals` (this customer's rows only count). */
export async function customerCreditDays(
  companyId: string, customerId: string, removals: readonly CreditRemoval[],
): Promise<{ customerName: string; days: CreditDay[] }> {
  const ids = removals.map((r) => r.paymentId);
  const amounts = removals.map((r) => (r.amount === undefined ? null : r.amount));
  const rows = (await sql`
    WITH gone AS (
      SELECT g.id, g.amt FROM unnest(${ids}::UUID[], ${amounts}::NUMERIC[]) AS g(id, amt)
    ), pay AS (
      SELECT cp.id, cp.payment_date AS d,
             cp.total_amount - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0)) AS remainder
      FROM customer_payments cp
      LEFT JOIN LATERAL (
        SELECT SUM(cpa.amount_allocated) AS allocated FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id
      ) alloc ON TRUE
      WHERE cp.company_id = ${companyId}::UUID AND cp.client_id = ${customerId}::UUID AND cp.status <> 'cancelled'
    )
    SELECT p.d,
           SUM(p.remainder) AS amount,
           COALESCE(SUM(COALESCE(g.amt, p.remainder)) FILTER (WHERE g.id IS NOT NULL), 0) AS removed,
           COALESCE(SUM(GREATEST(COALESCE(g.amt, p.remainder), 0)) FILTER (WHERE g.id IS NOT NULL), 0) AS lowers,
           COALESCE(SUM(p.remainder) FILTER (WHERE g.id IS NULL), 0) AS others,
           (SELECT c.name FROM customers c WHERE c.id = ${customerId}::UUID AND c.company_id = ${companyId}::UUID) AS customer_name
    FROM pay p LEFT JOIN gone g ON g.id = p.id
    GROUP BY p.d
    ORDER BY p.d`) as DbRow[];
  return {
    customerName: rows[0]?.customer_name ? String(rows[0].customer_name) : 'this customer',
    days: rows.map((r) => ({
      d: fmtDate(r.d as string | Date),
      amount: Number(r.amount ?? 0),
      removed: Number(r.removed ?? 0),
      lowers: Number(r.lowers ?? 0),
      others: Number(r.others ?? 0),
    })),
  };
}

/** The rule, on the per-day figures (in whole cents, oldest date first). */
export function judgeCreditDays(days: readonly CreditDay[]): CreditJudgement {
  const ordered = [...days].sort((a, b) => a.d.localeCompare(b.d));
  let cum = 0;
  let removed = 0;
  let lowers = 0;
  let fromDate: string | null = null;
  let lowest: number | null = null;
  let lowestAfter: number | null = null;
  for (const day of ordered) {
    cum += cents(day.amount);
    removed += cents(day.removed);
    lowers += cents(day.lowers);
    if (fromDate === null && cents(day.lowers) > 0) fromDate = day.d;
    if (fromDate !== null) lowest = lowest === null ? cum : Math.min(lowest, cum);
    if (removed > 0) lowestAfter = lowestAfter === null ? cum - removed : Math.min(lowestAfter, cum - removed);
  }
  return {
    fromDate,
    lowers: lowers / 100,
    lowest: (lowest ?? 0) / 100,
    lowestAfter: lowestAfter === null ? null : lowestAfter / 100,
  };
}

/** True when the write the figures describe takes the credit below zero on a date it lowers. */
export const lowersBelowZero = (j: CreditJudgement) => j.lowestAfter !== null && cents(j.lowestAfter) < 0;
