/**
 * The AR credit-ceiling skip of the auto-apply back-fill (2026-11-14): applying a receipt's remainder that a refund
 * already returned takes the customer's running on-account credit below zero, and `planReceiptApplication` refuses it
 * at write time (`ar/customerVoidCredit.assertReceiptApplicationKeepsCredit`). The population decides it FIRST, by the
 * same rule (`ar/customerRunningCredit.judgeCreditDays`), so a dry run and a live run report it identically.
 *
 * Per customer, walking the sources in run order, every source not already skipped is assumed to consume its WHOLE
 * remainder from its own date on (conservative: the live check, made on what was actually applied after the earlier
 * sources applied at most their remainders, then never refuses a source this let through). A source that would leave
 * the running credit below zero on a date it lowers is skipped and consumes nothing. AP is decided by
 * `markCreditCeilingSkips` (all dates, Hein 2026-10-26).
 *
 * The population read takes no customer lock (as AP's does not): a dry run can say "would apply" where the live run,
 * finding the customer row held by a refund or another write of its cash at that instant, reports the source as a
 * retryable failure. That is contention only — the rule's answer on the same books is the same in both modes.
 */
import {
  customerCreditDays, judgeCreditDays, lowersBelowZero, withDatedRemovals, type CreditDay,
} from '../ar/customerRunningCredit';
import type { BackfillSource, Subledger } from './autoApplyBackfillPlan';

export const SKIP_RECEIPT_CREDIT_CEILING =
  'the customer\'s running on-account credit, after its refunds, does not cover this receipt\'s whole remainder';

export async function markReceiptCreditSkips(
  companyId: string, subledger: Subledger, sources: readonly BackfillSource[],
): Promise<BackfillSource[]> {
  if (subledger !== 'ar') return [...sources];
  const isCandidate = (s: BackfillSource) => s.kind === 'payment' && !s.skippedReason && !!s.entityId;
  const daysOf = new Map<string, CreditDay[]>();
  for (const id of new Set(sources.filter(isCandidate).map((s) => s.entityId!.toLowerCase()))) {
    daysOf.set(id, (await customerCreditDays(companyId, id, [])).days);
  }
  const taken = new Map<string, { date: string; amount: number }[]>();
  return sources.map((source) => {
    if (!isCandidate(source)) return source;
    const key = source.entityId!.toLowerCase();
    const tentative = [...(taken.get(key) ?? []), { date: source.paymentDate, amount: source.remainder }];
    if (lowersBelowZero(judgeCreditDays(withDatedRemovals(daysOf.get(key) ?? [], tentative)))) {
      return { ...source, skippedReason: SKIP_RECEIPT_CREDIT_CEILING };
    }
    taken.set(key, tentative);
    return source;
  });
}
