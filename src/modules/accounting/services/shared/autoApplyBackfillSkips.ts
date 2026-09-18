/**
 * Why a source may not be applied, and reading the two payment reports into
 * sources that say so.
 *
 * Split from autoApplyBackfillPopulation for the 300-line cap. The seam is the
 * altitude: the population decides WHICH sources a run considers and in what
 * order, and everything here turns one report row into one source.
 *
 * EVERY SKIP IS A FACT ABOUT THE SOURCE, never about the attempt, which is what
 * lets both modes reach the same answer from the same read. A dry run that
 * planned what a live run withholds is not a preview: the withheld application
 * consumed balances on paper, so every later source against that contact
 * inherits the difference.
 */

import type { getUnappliedPayments } from '../ap/unappliedPaymentService';
import type { getUnappliedReceipts } from '../ar/unappliedReceiptService';
import type { BackfillSource } from './autoApplyBackfillPlan';

/**
 * Why a source may not be applied. One constant per reason, because these
 * strings are read by an operator deciding what to do about each list and are
 * asserted on by the tests that prove both modes agree.
 */
export const SKIP_CONTACT_UNRESOLVED = 'contact could not be resolved';
export const SKIP_NO_FISCAL_PERIOD = 'journal not in a fiscal period';
export const SKIP_NO_JOURNAL = 'no journal entry behind this cash';
export const skipUnapplicableStatus = (status: string): string =>
  `status "${status}" cannot take an application`;

/**
 * Receipt statuses `planReceiptApplication` REFUSES.
 *
 * The AR report's population is everything except 'cancelled', because a draft
 * receipt is still unapplied cash and the report is right to show it. The
 * back-fill cannot apply one — no journal has posted, so there is no cash to
 * apply — and it must decide that in the POPULATION rather than at write time.
 * Deciding it late is what made a dry run promise an application the live run
 * then refused, and every later receipt against that customer inherited the
 * difference.
 *
 * Not filtered out of the query: the source is reported in `skipped` with its
 * reason, so the plan still reconciles to `list_unapplied_receipts`.
 */
const UNAPPLIABLE_RECEIPT_STATUSES = new Set(['draft', 'cancelled']);

/**
 * The AP page AND its unattributed rows.
 *
 * `unattributed` is not a curiosity to drop — it is every payment whose
 * supplier no longer resolves, and `list_unapplied_payments` reports it as part
 * of the same balance. The first version of this filtered them out with a
 * `.filter()`, which meant the plan's totals could not be reconciled against
 * the report an operator was reading beside it.
 */
export function apSources(result: Awaited<ReturnType<typeof getUnappliedPayments>>): BackfillSource[] {
  const attributed = result.rows.map((r) => ({
    kind: 'payment' as const,
    paymentId: r.paymentId,
    paymentNumber: r.paymentNumber,
    entityId: r.supplierId,
    entityName: r.supplierName ?? '',
    paymentDate: r.paymentDate,
    remainder: r.unappliedAmount,
    journalEntryId: r.journalEntryId,
    skippedReason: r.supplierId ? null : SKIP_CONTACT_UNRESOLVED,
  }));
  const orphans = result.unattributed.map((r) => ({
    kind: 'payment' as const,
    paymentId: r.paymentId,
    paymentNumber: r.paymentNumber,
    entityId: null,
    entityName: '',
    paymentDate: r.paymentDate,
    remainder: r.unappliedAmount,
    journalEntryId: r.journalEntryId,
    skippedReason: SKIP_CONTACT_UNRESOLVED,
  }));
  return [...attributed, ...orphans];
}

/** The AR twin, plus the statuses the receipt applier refuses. */
export function arSources(result: Awaited<ReturnType<typeof getUnappliedReceipts>>): BackfillSource[] {
  const attributed = result.rows.map((r) => ({
    kind: 'payment' as const,
    paymentId: r.paymentId,
    paymentNumber: r.paymentNumber,
    entityId: r.customerId,
    entityName: r.customerName ?? '',
    paymentDate: r.paymentDate,
    remainder: r.unappliedAmount,
    journalEntryId: r.journalEntryId,
    skippedReason: !r.customerId
      ? SKIP_CONTACT_UNRESOLVED
      : UNAPPLIABLE_RECEIPT_STATUSES.has(r.status)
        ? skipUnapplicableStatus(r.status)
        : null,
  }));
  const orphans = result.unattributed.map((r) => ({
    kind: 'payment' as const,
    paymentId: r.paymentId,
    paymentNumber: r.paymentNumber,
    entityId: null,
    entityName: '',
    paymentDate: r.paymentDate,
    remainder: r.unappliedAmount,
    journalEntryId: r.journalEntryId,
    skippedReason: SKIP_CONTACT_UNRESOLVED,
  }));
  return [...attributed, ...orphans];
}
