/**
 * Why a source may not be applied, and reading L3's unapplied-payment basis
 * into sources that say so.
 *
 * Split from autoApplyBackfillPopulation for the 300-line cap. The seam is the
 * altitude: the population decides WHICH sources a run considers and in what
 * order, and everything here turns one basis row into one source.
 *
 * THE BASIS IS NOT RESTATED. `shared/unappliedPaymentBasis` owns what
 * "unapplied" means — the document basis, the cents threshold, the allocation
 * cap that stops an over-allocated payment reading as negative cash, and the
 * status filter that differs by side. It exists because two tools once answered
 * that question differently and whichever a reader ran first decided what they
 * believed. A back-fill acting on a third definition would be the same defect
 * with money moving behind it.
 *
 * EVERY SKIP IS A FACT ABOUT THE SOURCE, never about the attempt, which is what
 * lets both modes reach the same answer from the same read. A dry run that
 * planned what a live run withholds is not a preview: the withheld application
 * consumed balances on paper, so every later source against that contact
 * inherits the difference.
 */

import type {
  UnappliedPaymentBasisRow, UnappliedSide,
} from './unappliedPaymentBasis';
import type { BackfillSource } from './autoApplyBackfillPlan';

/**
 * Why a source may not be applied. One constant per reason, because these
 * strings are read by an operator deciding what to do about each list and are
 * asserted on by the tests that prove both modes agree.
 */
export const SKIP_CONTACT_UNRESOLVED = 'contact could not be resolved';
export const SKIP_NO_FISCAL_PERIOD = 'journal not in a fiscal period';
export const SKIP_NO_JOURNAL = 'no journal entry behind this cash';
/**
 * A REFUND (migration 681) is a negative on-account entry: cash the company
 * sent back, carrying no allocations and a negative remainder. "Applying" it to
 * an open bill would write a NEGATIVE allocation and un-pay that bill — the
 * back-fill would be reversing settlements nobody asked it to touch.
 *
 * It is SKIPPED WITH A REASON rather than filtered out of the population, for
 * the same reason every other skip is: the plan has to reconcile line for line
 * against `list_unapplied_payments`, which reports the refund. Filtering it
 * would make the plan's total differ from the report an operator is reading
 * beside it, by exactly the amount nobody can account for.
 */
export const SKIP_REFUND = 'a refund is a negative on-account entry and is never applied';
/**
 * AP: applying this cash would take the supplier's on-account credit below zero — a refund has already returned
 * it (Hein, 2026-10-25: refuse). `planSupplierPaymentApplication` refuses the same application at write time; the
 * population decides it first so a dry run and a live run report it identically.
 */
export const SKIP_CREDIT_CEILING = 'the supplier\'s on-account credit, after its refunds, does not cover this payment\'s whole remainder';
export const skipUnapplicableStatus = (status: string): string =>
  `status "${status}" cannot take an application`;

/**
 * Receipt statuses `planReceiptApplication` REFUSES.
 *
 * The basis admits every non-cancelled receipt on the AR side, because a draft
 * receipt is still unapplied cash and the report is right to show it. The
 * back-fill cannot apply one — no journal has posted, so there is no cash to
 * apply — and it must decide that in the POPULATION rather than at write time.
 * Deciding it late is what made a dry run promise an application the live run
 * then refused, and every later receipt against that customer inherited the
 * difference.
 *
 * Not filtered out: the source is reported in `skipped` with its reason, so the
 * plan still reconciles to `list_unapplied_receipts`.
 *
 * AP needs no twin. The basis already restricts that side to `processed` and
 * `reconciled`, which are exactly the statuses whose journal has posted.
 */
const UNAPPLIABLE_RECEIPT_STATUSES = new Set(['draft', 'cancelled']);

/**
 * One basis row as a back-fill source, carrying the reason it may not be
 * applied when there is one.
 *
 * `attributed` is the basis's own answer to whether the counterparty resolved,
 * and it is taken rather than re-derived from a null name: a real, non-deleted
 * supplier whose `name` column is null would otherwise be reported as an orphan
 * by this mapper while the query counted it as attributed.
 *
 * An unattributed row is NOT dropped. The first version of this filtered them
 * out, which meant the plan's totals could not be reconciled against the report
 * an operator was reading beside it — the cash is real whether or not the
 * contact record still is.
 */
export function basisSources(
  side: UnappliedSide,
  rows: readonly UnappliedPaymentBasisRow[],
): BackfillSource[] {
  return rows.map((r) => ({
    kind: 'payment' as const,
    paymentId: r.paymentId,
    paymentNumber: r.paymentNumber,
    entityId: r.attributed ? r.entityId : null,
    entityName: r.entityName ?? '',
    paymentDate: r.paymentDate,
    remainder: r.unappliedAmount,
    journalEntryId: r.journalEntryId,
    skippedReason: skipReasonFor(side, r),
  }));
}

function skipReasonFor(side: UnappliedSide, row: UnappliedPaymentBasisRow): string | null {
  // FIRST. A refund with an unresolved contact is still a refund, and naming
  // the contact as the reason would send somebody to fix a supplier record that
  // would change nothing about whether this cash may be applied.
  if (row.kind === 'refund') return SKIP_REFUND;
  if (!row.attributed || !row.entityId) return SKIP_CONTACT_UNRESOLVED;
  if (side === 'ar' && UNAPPLIABLE_RECEIPT_STATUSES.has(row.status)) {
    return skipUnapplicableStatus(row.status);
  }
  return null;
}

/**
 * The credit-ceiling skip, for every AP source at once. `creditBySupplier` is each supplier's on-account credit over
 * EVERY date (`ap/supplierOnAccountCredit`, `creditAllDates`) — the same figure the live plan checks, so a refund
 * dated after today counts here too. Walking the sources in run order, every source not already skipped is assumed to
 * consume its WHOLE remainder: conservative (a source with nothing open consumed nothing), so the live run's own
 * check, made on what was actually applied, never refuses a source this one let through. A skipped source consumes
 * nothing. The skip is all-or-nothing, as the live refusal is: a source the credit covers only in part is left for an
 * operator to apply by hand, up to the credit.
 */
export function markCreditCeilingSkips(
  side: UnappliedSide,
  creditBySupplier: ReadonlyMap<string, number>,
  sources: readonly BackfillSource[],
): BackfillSource[] {
  if (side !== 'ap') return [...sources];
  const credit = new Map(creditBySupplier);
  return sources.map((source) => {
    if (source.kind !== 'payment' || source.skippedReason || !source.entityId) return source;
    const key = source.entityId.toLowerCase();
    const left = credit.get(key) ?? 0;
    if (Math.round(source.remainder * 100) > Math.round(left * 100)) {
      return { ...source, skippedReason: SKIP_CREDIT_CEILING };
    }
    credit.set(key, left - source.remainder);
    return source;
  });
}
