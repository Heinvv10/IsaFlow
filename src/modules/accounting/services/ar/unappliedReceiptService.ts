/**
 * Customer receipts that are in the ledger but attached to no invoice.
 *
 * WHAT PRODUCES THEM. `bankAllocationService#allocateTransaction` with
 * `allocType='customer'` posts DR Bank / CR Accounts Receivable and inserts a
 * `customer_payments` row already at status `confirmed`, then writes no
 * `customer_payment_allocations` and never touches
 * `customer_invoices.amount_paid`. The cash is on the control account and no
 * document knows about it. R2.45m of the R1,429,774 AR reconciling difference
 * on Brightsphere is exactly this.
 *
 * SINCE MIGRATION 614 that is the behaviour when the customer's
 * `auto_allocate_strategy` is 'off', which is the default and remains the case
 * for every customer who has not set one. A customer set to 'oldest' or
 * 'newest' has its receipts applied at allocation time and never reaches this
 * report — the population here is shrinking rather than gone.
 *
 * WHAT COUNTS AS UNAPPLIED IS NOT DECIDED HERE. It is
 * `shared/unappliedPaymentBasis.ts`, which `reconcile_subledger` reads through
 * the same function, so the two tools cannot answer one question with two
 * numbers. This file pages and attributes; it does not define.
 *
 * WHAT THIS DOES NOT SEE, and the limit is real rather than defensive: cash
 * credited to the AR control account by a plain journal, with no
 * `customer_payments` row behind it. `allocateTransaction` skips its payment
 * INSERT when it cannot resolve a uuid-shaped user, and a hand-written journal
 * never creates one at all. Those postings move the control account and are
 * invisible here. Finding them is a control-account-versus-subledger
 * reconciliation (`reconcile_subledger`), not a receipt listing.
 */

import {
  getUnappliedPaymentBasis,
  type UnappliedPaymentKind,
  type UnappliedPaymentBasisRow,
} from '../shared/unappliedPaymentBasis';

/**
 * How many orphaned receipts are listed in full. They are a finding rather than
 * a page, so the number should be small; exceeding this raises the envelope's
 * completeness fault rather than silently truncating a total.
 */
const UNATTRIBUTED_CAP = 500;

export interface UnappliedReceiptRow {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string;
  customerId: string | null;
  customerName: string | null;
  receiptAmount: number;
  allocatedAmount: number;
  /**
   * NEGATIVE on a refund (migration 681): cash the company paid BACK to the
   * customer, which nets against that customer's other remainders rather than
   * adding to them.
   */
  unappliedAmount: number;
  /**
   * `'refund'` or `'payment'`. Read `kind`, never the sign — the sign is
   * arithmetic, the kind is what the document IS.
   */
  kind: UnappliedPaymentKind;
  status: string;
  reference: string | null;
  description: string | null;
  /** The journal that put this cash on the control account, when there is one. */
  journalEntryId: string | null;
}

export interface UnappliedReceiptsResult {
  rows: UnappliedReceiptRow[];
  /** Receipts with an unapplied remainder that this report could attribute. */
  rowsTotal: number;
  /** Every receipt with an unapplied remainder, before the attribution filter. */
  universeTotal: number;
  /**
   * EVERY receipt whose customer cannot be resolved, not just the ones on this
   * page — the caller reports them as `excludedRows`, and the envelope's
   * completeness check (`rowsTotal + excluded === universeTotal`) only means
   * anything if the excluded set is complete. Capped at `UNATTRIBUTED_CAP`;
   * going over it raises a completeness fault, which is the correct outcome — a
   * book with hundreds of orphaned receipts has a bigger problem than a
   * truncated list.
   */
  unattributed: UnappliedReceiptRow[];
  /** Sum of `unappliedAmount` over `rowsTotal` receipts. Not just the page. */
  totalUnapplied: number;
  /** Sum over the unattributed ones, so the two figures can be added honestly. */
  totalUnattributed: number;
  /** MAX(created_at) of the rows consumed, as an ISO timestamp. Never now(). */
  postedThrough: string;
}

export interface UnappliedReceiptsOptions {
  /** Receipts dated on or before this day, YYYY-MM-DD. */
  asAt: string;
  limit: number;
  /** Keyset cursor: `[payment_date, id]` of the last row served. */
  after?: { paymentDate: string; id: string } | null;
}

export async function getUnappliedReceipts(
  companyId: string,
  opts: UnappliedReceiptsOptions,
): Promise<UnappliedReceiptsResult> {
  const basis = await getUnappliedPaymentBasis(companyId, 'ar', opts.asAt);

  const attributed = basis.rows.filter((r) => r.attributed);
  const orphans = basis.rows.filter((r) => !r.attributed);

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

function mapRow(row: UnappliedPaymentBasisRow): UnappliedReceiptRow {
  return {
    paymentId: row.paymentId,
    paymentNumber: row.paymentNumber,
    paymentDate: row.paymentDate,
    // NULL when the customer row is gone or soft-deleted. Reported as
    // unattributed rather than dropped: the cash is real either way.
    customerId: row.entityId,
    customerName: row.entityName,
    receiptAmount: row.totalAmount,
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
