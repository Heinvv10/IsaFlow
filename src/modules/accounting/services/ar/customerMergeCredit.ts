/**
 * The customer merge's running-credit guard (#1354 follow-up, 2026-11-15; made direction-free after review round 1).
 * A merge re-parents the source's receipts and refunds onto the target, so the target's account becomes the SUM of the
 * two by date. The merged account's running on-account credit (`ar/customerRunningCredit`, the AR basis every refund
 * and receipt write is judged by: receipts less refunds, each at its unapplied remainder, cancelled rows out) must not
 * be below zero on ANY date. A merge must neither produce nor carry over a negative running credit.
 *
 * SYMMETRIC, on purpose: which customer is the source and which the target changes nothing about the merged ledger, so
 * it must change nothing about the verdict. An earlier cut judged only the dates the merge lowered (the source's
 * contribution below zero), which let `B -> A` through where `A -> B` was refused, identical ledgers either way.
 * Consequences, all from the one rule:
 *   - a customer already negative on some date cannot be merged (either way, or with no receipt moved at all) until
 *     the uncovered refund is reversed or the receipt it returned is recorded;
 *   - one customer's receipts cover the other's refunds only on or before the refund's date (judged by date, never on
 *     the total; a day nets);
 *   - a merge that leaves every date at or above zero changes nothing about how merges behave.
 *
 * Judged on the REAL rows after the move (`customerCreditDays` through the merge's own transaction), never predicted.
 *
 * LOCKS: none added. The merge already holds the target's customer row (`FOR NO KEY UPDATE`, waited, 5 s) before it
 * moves anything; every other write that lowers the target's credit takes that row TRIED (`customerCreditLock`) or a
 * refund takes it `FOR UPDATE`, so none can change the rows between the move and this read. Only SELECTs run here.
 *
 * REFUSAL: `CustomerMergeCreditRefusal`, an `ArRequestError` 400 carrying `CUSTOMER_MERGE_CREDIT_REFUSED` (the routes
 * answer its message), raised inside the merge's savepoint, so the whole merge rolls back before `withAuth` COMMITs.
 */
import type { TxSql } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { ArRequestError } from './arErrors';
import { customerCreditDays, type CreditDay } from './customerRunningCredit';
import { cents } from './receiptInvoiceLock';

export class CustomerMergeCreditRefusal extends ArRequestError {
  constructor(message: string) {
    super(message, 400, 'CUSTOMER_MERGE_CREDIT_REFUSED');
    this.name = 'CustomerMergeCreditRefusal';
  }
}

export interface MergeCreditShortfall {
  /** The earliest date the merged account's running credit is below zero. */
  date: string;
  credit: number;
}

/** The rule, in one pass over the merged account's per-day figures (whole cents, oldest date first). */
export function mergeCreditShortfall(days: readonly CreditDay[]): MergeCreditShortfall | null {
  let running = 0;
  for (const day of [...days].sort((a, b) => a.d.localeCompare(b.d))) {
    running += cents(day.amount);
    if (running < 0) return { date: day.d, credit: running / 100 };
  }
  return null;
}

/** Refuse (rolling the merge back) when the merged account is below zero on any date. Call AFTER the move. */
export async function assertMergeKeepsCredit(
  tx: TxSql, companyId: string, targetId: string, sourceId: string,
): Promise<void> {
  const { customerName, days } = await customerCreditDays(companyId, targetId, [], tx);
  const short = mergeCreditShortfall(days);
  if (!short) return;
  const named = await tx`
    SELECT name FROM customers WHERE id = ${sourceId}::UUID AND company_id = ${companyId}::UUID
  ` as Array<{ name: string }>;
  const source = named[0]?.name ?? 'the duplicate';
  throw new CustomerMergeCreditRefusal(
    `Merging ${source} into ${customerName} would leave ${customerName} owing the company: from ${short.date} the `
    + `refunds already paid out exceed the receipts on account (${formatMoney(short.credit)} on that date). Nothing `
    + 'was merged. Reverse the refund that no receipt covers, or record the receipt it returned, first.',
  );
}
