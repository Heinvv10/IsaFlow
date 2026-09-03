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
 * An unapplied receipt is therefore a non-cancelled `customer_payments` row
 * whose `total_amount` exceeds the sum of its allocations. Partial application
 * counts: a R100,000 receipt with R40,000 allocated is R60,000 of unapplied
 * cash, and reporting only the wholly unallocated ones would miss it.
 *
 * WHAT THIS DOES NOT SEE, and the limit is real rather than defensive: cash
 * credited to the AR control account by a plain journal, with no
 * `customer_payments` row behind it. `allocateTransaction` skips its payment
 * INSERT when it cannot resolve a uuid-shaped user, and a hand-written journal
 * never creates one at all. Those postings move the control account and are
 * invisible here. Finding them is a control-account-versus-subledger
 * reconciliation (`reconcile_subledger`), not a receipt listing.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

/** A cent. Anything smaller is rounding, not an unapplied receipt. */
const EPS = 0.01;

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
  unappliedAmount: number;
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
   * anything if the excluded set is complete. Capped at
   * `UNATTRIBUTED_CAP`; going over it raises a completeness fault, which is the
   * correct outcome — a book with hundreds of orphaned receipts has a bigger
   * problem than a truncated list.
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

interface Row extends DbRow {
  id: string;
  payment_number: string | null;
  payment_date: string | Date;
  client_id: string | null;
  customer_name: string | null;
  total_amount: string | number;
  allocated_amount: string | number;
  status: string;
  bank_reference: string | null;
  description: string | null;
  gl_journal_entry_id: string | null;
}

export async function getUnappliedReceipts(
  companyId: string,
  opts: UnappliedReceiptsOptions,
): Promise<UnappliedReceiptsResult> {
  const cursorDate = opts.after?.paymentDate ?? null;
  const cursorId = opts.after?.id ?? null;

  // One page of ATTRIBUTED receipts, ordered oldest first: the oldest unapplied
  // cash is the most likely to be the reconciling item somebody is looking for.
  // Unattributed rows are deliberately not in this stream — they are reported
  // in full below, so paging cannot serve half of them.
  const rows = (await sql`
    SELECT cp.id,
           cp.payment_number,
           cp.payment_date,
           cp.client_id,
           c.name AS customer_name,
           cp.total_amount,
           cp.status,
           cp.bank_reference,
           cp.description,
           cp.gl_journal_entry_id,
           COALESCE(alloc.allocated, 0) AS allocated_amount
    FROM customer_payments cp
    LEFT JOIN customers c
      ON c.id = cp.client_id
     AND c.company_id = cp.company_id
     AND c.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT SUM(cpa.amount_allocated) AS allocated
      FROM customer_payment_allocations cpa
      WHERE cpa.payment_id = cp.id
    ) alloc ON TRUE
    WHERE cp.company_id = ${companyId}::UUID
      AND cp.status <> 'cancelled'
      AND cp.payment_date <= ${opts.asAt}::DATE
      AND (cp.total_amount - COALESCE(alloc.allocated, 0)) > ${EPS}
      AND c.id IS NOT NULL
      AND (
        ${cursorDate}::DATE IS NULL
        OR (cp.payment_date, cp.id) > (${cursorDate}::DATE, ${cursorId}::UUID)
      )
    ORDER BY cp.payment_date ASC, cp.id ASC
    LIMIT ${opts.limit}
  `) as Row[];

  // The whole unattributed set, unpaged. See the note on `unattributed`.
  const orphanRows = (await sql`
    SELECT cp.id,
           cp.payment_number,
           cp.payment_date,
           cp.client_id,
           NULL::TEXT AS customer_name,
           cp.total_amount,
           cp.status,
           cp.bank_reference,
           cp.description,
           cp.gl_journal_entry_id,
           COALESCE(alloc.allocated, 0) AS allocated_amount
    FROM customer_payments cp
    LEFT JOIN customers c
      ON c.id = cp.client_id
     AND c.company_id = cp.company_id
     AND c.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT SUM(cpa.amount_allocated) AS allocated
      FROM customer_payment_allocations cpa
      WHERE cpa.payment_id = cp.id
    ) alloc ON TRUE
    WHERE cp.company_id = ${companyId}::UUID
      AND cp.status <> 'cancelled'
      AND cp.payment_date <= ${opts.asAt}::DATE
      AND (cp.total_amount - COALESCE(alloc.allocated, 0)) > ${EPS}
      AND c.id IS NULL
    ORDER BY cp.payment_date ASC, cp.id ASC
    LIMIT ${UNATTRIBUTED_CAP}
  `) as Row[];

  // Totals and completeness over the WHOLE population, never inferred from the
  // page. `attributed` splits on whether the customer resolved, which is the
  // one classification this report makes and therefore the one that has to
  // account for every row.
  const totalsRows = (await sql`
    SELECT COUNT(*)::INT AS universe_total,
           COUNT(*) FILTER (WHERE c.id IS NOT NULL)::INT AS rows_total,
           COALESCE(SUM(cp.total_amount - COALESCE(alloc.allocated, 0))
                    FILTER (WHERE c.id IS NOT NULL), 0) AS total_unapplied,
           COALESCE(SUM(cp.total_amount - COALESCE(alloc.allocated, 0))
                    FILTER (WHERE c.id IS NULL), 0) AS total_unattributed,
           MAX(cp.created_at) AS posted_through
    FROM customer_payments cp
    LEFT JOIN customers c
      ON c.id = cp.client_id
     AND c.company_id = cp.company_id
     AND c.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT SUM(cpa.amount_allocated) AS allocated
      FROM customer_payment_allocations cpa
      WHERE cpa.payment_id = cp.id
    ) alloc ON TRUE
    WHERE cp.company_id = ${companyId}::UUID
      AND cp.status <> 'cancelled'
      AND cp.payment_date <= ${opts.asAt}::DATE
      AND (cp.total_amount - COALESCE(alloc.allocated, 0)) > ${EPS}
  `) as DbRow[];
  // A COUNT with no GROUP BY always returns exactly one row from Postgres; the
  // fallback is only for a mocked `sql` in the tool-manifest sweep, which
  // answers every query with [].
  const totals = totalsRows[0] ?? {};

  // The figure consumes allocations as well as receipts: an allocation written
  // a minute ago changes an unapplied amount without touching the receipt row,
  // so a posted_through taken from customer_payments alone would claim the
  // report is re-derivable when it is not.
  const allocRows = (await sql`
    SELECT MAX(cpa.created_at) AS posted_through
    FROM customer_payment_allocations cpa
    JOIN customer_payments cp ON cp.id = cpa.payment_id
    WHERE cp.company_id = ${companyId}::UUID
  `) as DbRow[];

  return {
    rows: rows.map(mapRow),
    rowsTotal: Number(totals.rows_total ?? 0),
    universeTotal: Number(totals.universe_total ?? 0),
    unattributed: orphanRows.map(mapRow),
    totalUnapplied: round2(Number(totals.total_unapplied ?? 0)),
    totalUnattributed: round2(Number(totals.total_unattributed ?? 0)),
    postedThrough: maxTimestamp(totals.posted_through, allocRows[0]?.posted_through),
  };
}

function mapRow(row: Row): UnappliedReceiptRow {
  const receiptAmount = Number(row.total_amount);
  const allocatedAmount = Number(row.allocated_amount ?? 0);
  return {
    paymentId: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    paymentDate: fmtDate(row.payment_date),
    // NULL when the customer row is gone or soft-deleted. Reported as
    // unattributed rather than dropped: the cash is real either way.
    customerId: row.customer_name === null ? null : (row.client_id ? String(row.client_id) : null),
    customerName: row.customer_name === null ? null : String(row.customer_name),
    receiptAmount,
    allocatedAmount: round2(allocatedAmount),
    unappliedAmount: round2(receiptAmount - allocatedAmount),
    status: String(row.status),
    reference: row.bank_reference ? String(row.bank_reference) : null,
    description: row.description ? String(row.description) : null,
    journalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : null,
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
