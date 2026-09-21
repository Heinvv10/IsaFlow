/**
 * Supplier payments that are in the ledger but attached to no bill.
 *
 * WHAT PRODUCES THEM. `bankAllocationService#allocateTransaction` with
 * `allocType='supplier'` posts DR Accounts Payable / CR Bank and inserts a
 * `supplier_payments` row, and — when the supplier's `auto_allocate_strategy`
 * is 'off', which is the default — writes no `payment_allocations` and never
 * touches `supplier_invoices.amount_paid`. The cash has left the bank, the AP
 * control account has been debited, and no bill knows about it. The AP mirror
 * of the AR defect that put R2.45m on Brightsphere's control account.
 *
 * Before migration 614 that row did not exist at ALL: the allocation created no
 * document and flagged an arbitrary bill `payment_matched` instead, so this
 * report would have found nothing while the cash was just as unapplied. A
 * supplier set to 'oldest' or 'newest' has its payments applied at allocation
 * time and never reaches this report.
 *
 * WHAT COUNTS AS UNAPPLIED IS NOT DECIDED HERE. It is
 * `shared/unappliedPaymentBasis.ts`, which `reconcile_subledger` reads through
 * the same function — this report and that reconciliation used to answer the
 * same question with different numbers (different basis, different threshold,
 * different status filter), and the only defence against that recurring is one
 * definition with one caller-visible name. This file pages and attributes; it
 * does not define.
 *
 * WHAT THIS DOES NOT SEE, and the limit is real rather than defensive: cash
 * debited to the AP control account by a plain journal, with no
 * `supplier_payments` row behind it — a hand-written journal, or any of the
 * cash posted this way before migration 614. Those postings move the control
 * account and are invisible here. Finding them is a control-account-versus-subledger
 * reconciliation (`reconcile_subledger`), not a payment listing.
 */

import {
  getUnappliedPaymentBasis,
  type UnappliedPaymentBasisRow,
  type UnappliedPaymentKind,
} from '../shared/unappliedPaymentBasis';

/**
 * How many orphaned payments are listed in full. They are a finding rather than
 * a page, so the number should be small; exceeding this raises the envelope's
 * completeness fault rather than silently truncating a total.
 */
const UNATTRIBUTED_CAP = 500;

export interface UnappliedPaymentRow {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string;
  supplierId: string | null;
  supplierName: string | null;
  paymentAmount: number;
  allocatedAmount: number;
  /**
   * NEGATIVE on a refund. A refund (migration 681) is cash the company sent
   * BACK to the supplier, recorded as a negative on-account entry, so it nets
   * against this supplier's other remainders in every total built from these
   * rows instead of adding to them.
   */
  unappliedAmount: number;
  /**
   * `'refund'` or `'payment'`. Read `kind`, never the sign: a reader that
   * decides what a row IS from whether a number happens to be negative is one
   * rounding artefact away from mislabelling a document.
   */
  kind: UnappliedPaymentKind;
  status: string;
  reference: string | null;
  description: string | null;
  /** The journal that put this cash on the control account, when there is one. */
  journalEntryId: string | null;
}

export interface UnappliedPaymentsResult {
  rows: UnappliedPaymentRow[];
  /** Payments with an unapplied remainder that this report could attribute. */
  rowsTotal: number;
  /** Every payment with an unapplied remainder, before the attribution filter. */
  universeTotal: number;
  /**
   * EVERY payment whose supplier cannot be resolved, not just the ones on this
   * page — the caller reports them as `excludedRows`, and the envelope's
   * completeness check (`rowsTotal + excluded === universeTotal`) only means
   * anything if the excluded set is complete. Capped at `UNATTRIBUTED_CAP`;
   * going over it raises a completeness fault, which is the correct outcome — a
   * book with hundreds of orphaned payments has a bigger problem than a
   * truncated list.
   */
  unattributed: UnappliedPaymentRow[];
  /** Sum of `unappliedAmount` over `rowsTotal` payments. Not just the page. */
  totalUnapplied: number;
  /** Sum over the unattributed ones, so the two figures can be added honestly. */
  totalUnattributed: number;
  /** MAX(created_at) of the rows consumed, as an ISO timestamp. Never now(). */
  postedThrough: string;
}

export interface UnappliedPaymentsOptions {
  /** Payments dated on or before this day, YYYY-MM-DD. */
  asAt: string;
  limit: number;
  /** Keyset cursor: `[payment_date, id]` of the last row served. */
  after?: { paymentDate: string; id: string } | null;
}

export async function getUnappliedPayments(
  companyId: string,
  opts: UnappliedPaymentsOptions,
): Promise<UnappliedPaymentsResult> {
  const basis = await getUnappliedPaymentBasis(companyId, 'ap', opts.asAt);

  // Two streams over ONE population, so every row lands in exactly one of them
  // and the completeness identity can actually fail when it should.
  const attributed = basis.rows.filter((r) => r.attributed);
  const orphans = basis.rows.filter((r) => !r.attributed);

  // Keyset paging, oldest first: the oldest unapplied cash is the most likely
  // to be the reconciling item somebody is looking for. Orphans are
  // deliberately NOT in this stream — they are reported in full, so paging
  // cannot serve half of them.
  const after = opts.after ?? null;
  const start = after === null
    ? 0
    : attributed.findIndex(
        (r) => r.paymentDate > after.paymentDate
          || (r.paymentDate === after.paymentDate && r.paymentId > after.id),
      );
  const page = start < 0 ? [] : attributed.slice(start, start + opts.limit);

  return {
    rows: page.map(mapRow),
    // Counts and totals from the basis's SEPARATE aggregate, never measured off
    // `rows`: buildEnvelope checks rowsTotal + excluded === universeTotal, and a
    // universe derived from the rows it is checking cannot fail (CONTRACTS.md §1).
    rowsTotal: basis.totals.rowsTotal,
    universeTotal: basis.totals.universeTotal,
    unattributed: orphans.slice(0, UNATTRIBUTED_CAP).map(mapRow),
    totalUnapplied: basis.totals.totalUnapplied,
    totalUnattributed: basis.totals.totalUnattributed,
    postedThrough: maxTimestamp(basis.totals.postedThrough, basis.allocationsPostedThrough),
  };
}

function mapRow(row: UnappliedPaymentBasisRow): UnappliedPaymentRow {
  return {
    paymentId: row.paymentId,
    paymentNumber: row.paymentNumber,
    paymentDate: row.paymentDate,
    // NULL when the supplier row is gone or soft-deleted. Reported as
    // unattributed rather than dropped: the cash is real either way.
    supplierId: row.entityId,
    supplierName: row.entityName,
    paymentAmount: row.totalAmount,
    allocatedAmount: row.allocatedAmount,
    unappliedAmount: row.unappliedAmount,
    kind: row.kind,
    status: row.status,
    reference: row.reference,
    description: row.description,
    journalEntryId: row.journalEntryId,
  };
}

/**
 * pg hands timestamps back as Date objects on some columns and strings on
 * others, so both shapes are normalised before comparison.
 */
function maxTimestamp(a: unknown, b: unknown): string {
  const values = [a, b]
    .filter((v): v is string | Date => v !== null && v !== undefined)
    .map((v) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString()));
  if (values.length === 0) return new Date(0).toISOString();
  return values.sort()[values.length - 1]!;
}
