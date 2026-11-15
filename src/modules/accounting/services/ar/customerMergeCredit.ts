/**
 * The customer merge's running-credit guard (#1354 follow-up, 2026-11-15). A merge re-parents the source's receipts
 * and refunds onto the target, so it adds the source's by-date credit to the target's. It must not leave the target's
 * running on-account credit (`ar/customerRunningCredit`, the AR basis every refund and receipt write is judged by)
 * below zero on a date the merge lowers — the very rule `judgeCreditDays` states, so a merge, a cancellation, an
 * application and a refund agree.
 *
 * The merge is a write that LOWERS the target's credit on every date where the source's running contribution is
 * below zero (a refund the source paid out that no source receipt covers yet). It RAISES it elsewhere. Judged on the
 * REAL rows after the move (`customerCreditDays` through the merge's own transaction), never predicted: the days are
 * the target's own with the moved receipts named as the removals, and `mergeCreditShortfall` hands them to
 * `judgeCreditDays` as the removal of the source's rows with the sign reversed (a merge adds what a cancellation
 * takes). Consequences, all from the one rule:
 *   - a source already negative on its own is refused unless the TARGET's receipts cover it on every date — a source
 *     refund dated BEFORE the target's receipt is refused (the credit is judged by date, never on the total);
 *   - a negative date the merge leaves alone (the source adds only credit there) is not the merge's to refuse, so a
 *     customer already below zero stays mergeable, as it stays correctable by any write that does not lower it.
 *
 * LOCKS: none added. The merge already holds the target's customer row (`FOR NO KEY UPDATE`, waited, 5 s) before it
 * moves anything; every other write that lowers the target's credit takes that row TRIED (`customerCreditLock`) or a
 * refund takes it `FOR UPDATE`, so none can change the rows between the move and this read. Only SELECTs run here.
 *
 * REFUSAL: `CustomerMergeCreditRefusal`, an `ArRequestError` 400 `CUSTOMER_MERGE_CREDIT_REFUSED` — raised inside the
 * merge's savepoint, so the whole merge rolls back before `withAuth` COMMITs the 4xx.
 */
import type { TxSql } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { ArRequestError } from './arErrors';
import {
  customerCreditDays, dayKey, judgeCreditDays, lowersBelowZero, type CreditDay,
} from './customerRunningCredit';
import { cents } from './receiptInvoiceLock';

export class CustomerMergeCreditRefusal extends ArRequestError {
  constructor(message: string) {
    super(message, 400, 'CUSTOMER_MERGE_CREDIT_REFUSED');
    this.name = 'CustomerMergeCreditRefusal';
  }
}

export interface MergeCreditShortfall {
  /** The earliest date the merged account's running credit is below zero on a date the merge lowers. */
  date: string;
  credit: number;
}

/** Re-parent the source's receipts and refunds (every status) onto the target; the ids moved, for the judgement. */
export async function moveReceipts(tx: TxSql, c: string, s: string, t: string): Promise<string[]> {
  const rows = await tx`
    UPDATE customer_payments SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID RETURNING id
  ` as Array<{ id: string }>;
  return rows.map((r) => String(r.id));
}

/**
 * The rule on the target's per-day figures AFTER the move. `removed` on each day is what the moved rows carry (a
 * refund's remainder is negative), `lowers` its positive part: the before-merge figures are the days less those rows.
 */
export function mergeCreditShortfall(afterMove: readonly CreditDay[]): MergeCreditShortfall | null {
  const days = afterMove
    .map((d) => ({
      d: dayKey(d.d),
      amount: (cents(d.amount) - cents(d.removed)) / 100,
      removed: -d.removed,
      lowers: (cents(d.lowers) - cents(d.removed)) / 100, // the refunds' share: what the merge takes off
      others: d.others,
    }))
    .sort((a, b) => a.d.localeCompare(b.d));
  if (!lowersBelowZero(judgeCreditDays(days))) return null;
  for (let i = 1; i <= days.length; i++) {
    const j = judgeCreditDays(days.slice(0, i));
    if (lowersBelowZero(j) && j.lowestAfter !== null) return { date: days[i - 1]!.d, credit: j.lowestAfter };
  }
  return null;
}

/** Refuse (rolling the merge back) when the moved receipts leave the target below zero on a date the merge lowers. */
export async function assertMergeKeepsCredit(
  tx: TxSql, companyId: string, sourceId: string, targetId: string, movedReceiptIds: readonly string[],
): Promise<void> {
  if (movedReceiptIds.length === 0) return; // nothing joined the target's account: nothing to judge
  const { customerName, days } = await customerCreditDays(
    companyId, targetId, movedReceiptIds.map((paymentId) => ({ paymentId })), tx);
  const short = mergeCreditShortfall(days);
  if (!short) return;
  const named = await tx`
    SELECT name FROM customers WHERE id = ${sourceId}::UUID AND company_id = ${companyId}::UUID
  ` as Array<{ name: string }>;
  const source = named[0]?.name ?? 'the duplicate';
  throw new CustomerMergeCreditRefusal(
    `Merging ${source} into ${customerName} would leave ${customerName} owing the company: from ${short.date} the `
    + `refunds already paid out exceed the receipts on account (${formatMoney(short.credit)} on that date). Nothing `
    + 'was merged. Reverse the refund, or record the receipt it returned, first — or merge the other way round.',
  );
}
