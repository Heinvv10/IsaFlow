/** Posted supplier cash remaining unapplied at an accounting-date cutoff. */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

/** A cent. Anything smaller is rounding, not an unapplied payment. */
const EPS = 0.01;

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
  unappliedAmount: number;
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

interface Row extends DbRow {
  id: string;
  payment_number: string | null;
  payment_date: string | Date;
  supplier_id: string | null;
  supplier_name: string | null;
  total_amount: string | number;
  allocated_amount: string | number;
  status: string;
  reference: string | null;
  description: string | null;
  gl_journal_entry_id: string | null;
  /**
   * Which of the two streams this row came from, stated BY the query that
   * classified it. Deriving it here from a null `supplier_name` instead would
   * disagree with the SQL for a real, non-deleted supplier whose `name` column
   * is null — the `s.id IS NOT NULL` page would emit it and this mapper would
   * report it as an orphan.
   */
  attributed: boolean;
}

export async function getUnappliedPayments(
  companyId: string,
  opts: UnappliedPaymentsOptions,
): Promise<UnappliedPaymentsResult> {
  const cursorDate = opts.after?.paymentDate ?? null;
  const cursorId = opts.after?.id ?? null;

  // One page of ATTRIBUTED payments, ordered oldest first: the oldest unapplied
  // cash is the most likely to be the reconciling item somebody is looking for.
  // Unattributed rows are deliberately not in this stream — they are reported
  // in full below, so paging cannot serve half of them.
  //
  // WHY THE OUTER JOIN'S ON CLAUSE CARRIES PREDICATES HERE, and why that is not
  // the defect it usually is. A predicate that must RESTRICT a result belongs in
  // WHERE: inside an outer join's ON it restricts nothing, the unmatched row
  // survives with NULL columns, and those NULLs flow into the arithmetic.
  //
  // These predicates are NOT trying to restrict. They define which supplier row
  // counts as a match — same tenant, not soft-deleted — and a payment whose
  // supplier fails them is meant to survive as unmatched, because the cash is
  // real whether or not the supplier record still is. The restriction is done
  // explicitly in WHERE (`s.id IS NOT NULL` here, `s.id IS NULL` in the orphan
  // query), so every row lands in exactly one of the two streams and no NULL
  // ever reaches a SUM. Moving them to WHERE would turn the outer join into an
  // inner one and silently DROP the orphaned payments — the very rows this
  // report exists to surface.
  const rows = (await sql`
    SELECT sp.id,
           sp.payment_number,
           sp.payment_date,
           sp.supplier_id,
           s.name AS supplier_name,
           TRUE AS attributed,
           sp.total_amount,
           sp.status,
           sp.reference,
           sp.description,
           sp.gl_journal_entry_id,
           COALESCE(alloc.allocated, 0) AS allocated_amount
    FROM supplier_payments sp
    LEFT JOIN suppliers s
      ON s.id = sp.supplier_id
     AND s.company_id = sp.company_id
     AND s.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT SUM(pa.amount_allocated) AS allocated
      FROM payment_allocations pa
      LEFT JOIN control_cash_application_intents app ON app.company_id = sp.company_id AND app.id = pa.application_intent_id
      LEFT JOIN control_cash_application_reversal_intents inverse ON inverse.company_id = sp.company_id AND inverse.id = pa.reversal_intent_id
      WHERE pa.payment_id = sp.id
        AND COALESCE(app.accounting_date, sp.payment_date) <= ${opts.asAt}::DATE
        AND (inverse.reversal_date IS NULL OR inverse.reversal_date > ${opts.asAt}::DATE)
    ) alloc ON TRUE
    WHERE sp.company_id = ${companyId}::UUID
      AND sp.status IN ('processed', 'reconciled')
      AND sp.payment_date <= ${opts.asAt}::DATE
      AND (sp.total_amount - COALESCE(alloc.allocated, 0)) > ${EPS}
      AND s.id IS NOT NULL
      AND (
        ${cursorDate}::DATE IS NULL
        OR (sp.payment_date, sp.id) > (${cursorDate}::DATE, ${cursorId}::UUID)
      )
    ORDER BY sp.payment_date ASC, sp.id ASC
    LIMIT ${opts.limit}
  `) as Row[];

  // The whole unattributed set, unpaged. See the note on `unattributed`.
  const orphanRows = (await sql`
    SELECT sp.id,
           sp.payment_number,
           sp.payment_date,
           sp.supplier_id,
           NULL::TEXT AS supplier_name,
           FALSE AS attributed,
           sp.total_amount,
           sp.status,
           sp.reference,
           sp.description,
           sp.gl_journal_entry_id,
           COALESCE(alloc.allocated, 0) AS allocated_amount
    FROM supplier_payments sp
    LEFT JOIN suppliers s
      ON s.id = sp.supplier_id
     AND s.company_id = sp.company_id
     AND s.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT SUM(pa.amount_allocated) AS allocated
      FROM payment_allocations pa
      LEFT JOIN control_cash_application_intents app ON app.company_id = sp.company_id AND app.id = pa.application_intent_id
      LEFT JOIN control_cash_application_reversal_intents inverse ON inverse.company_id = sp.company_id AND inverse.id = pa.reversal_intent_id
      WHERE pa.payment_id = sp.id
        AND COALESCE(app.accounting_date, sp.payment_date) <= ${opts.asAt}::DATE
        AND (inverse.reversal_date IS NULL OR inverse.reversal_date > ${opts.asAt}::DATE)
    ) alloc ON TRUE
    WHERE sp.company_id = ${companyId}::UUID
      AND sp.status IN ('processed', 'reconciled')
      AND sp.payment_date <= ${opts.asAt}::DATE
      AND (sp.total_amount - COALESCE(alloc.allocated, 0)) > ${EPS}
      AND s.id IS NULL
    ORDER BY sp.payment_date ASC, sp.id ASC
    LIMIT ${UNATTRIBUTED_CAP}
  `) as Row[];

  // Totals and completeness over the WHOLE population, never inferred from the
  // page. `attributed` splits on whether the supplier resolved, which is the
  // one classification this report makes and therefore the one that has to
  // account for every row.
  const totalsRows = (await sql`
    SELECT COUNT(*)::INT AS universe_total,
           COUNT(*) FILTER (WHERE s.id IS NOT NULL)::INT AS rows_total,
           COALESCE(SUM(sp.total_amount - COALESCE(alloc.allocated, 0))
                    FILTER (WHERE s.id IS NOT NULL), 0) AS total_unapplied,
           COALESCE(SUM(sp.total_amount - COALESCE(alloc.allocated, 0))
                    FILTER (WHERE s.id IS NULL), 0) AS total_unattributed,
           MAX(sp.created_at) AS posted_through
    FROM supplier_payments sp
    LEFT JOIN suppliers s
      ON s.id = sp.supplier_id
     AND s.company_id = sp.company_id
     AND s.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT SUM(pa.amount_allocated) AS allocated
      FROM payment_allocations pa
      LEFT JOIN control_cash_application_intents app ON app.company_id = sp.company_id AND app.id = pa.application_intent_id
      LEFT JOIN control_cash_application_reversal_intents inverse ON inverse.company_id = sp.company_id AND inverse.id = pa.reversal_intent_id
      WHERE pa.payment_id = sp.id
        AND COALESCE(app.accounting_date, sp.payment_date) <= ${opts.asAt}::DATE
        AND (inverse.reversal_date IS NULL OR inverse.reversal_date > ${opts.asAt}::DATE)
    ) alloc ON TRUE
    WHERE sp.company_id = ${companyId}::UUID
      AND sp.status IN ('processed', 'reconciled')
      AND sp.payment_date <= ${opts.asAt}::DATE
      AND (sp.total_amount - COALESCE(alloc.allocated, 0)) > ${EPS}
  `) as DbRow[];
  // A COUNT with no GROUP BY always returns exactly one row from Postgres; the
  // fallback is only for a mocked `sql` in the tool-manifest sweep, which
  // answers every query with [].
  const totals = totalsRows[0] ?? {};

  // The figure consumes allocations as well as payments: an allocation written
  // a minute ago changes an unapplied amount without touching the payment row,
  // so a posted_through taken from supplier_payments alone would claim the
  // report is re-derivable when it is not. `payment_allocations` has no
  // company_id of its own, so the scope comes through the payment.
  const allocRows = (await sql`
    SELECT MAX(pa.created_at) AS posted_through
    FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE sp.company_id = ${companyId}::UUID
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

function mapRow(row: Row): UnappliedPaymentRow {
  const paymentAmount = Number(row.total_amount);
  const allocatedAmount = Number(row.allocated_amount ?? 0);
  return {
    paymentId: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    paymentDate: fmtDate(row.payment_date),
    // NULL when the supplier row is gone or soft-deleted. Reported as
    // unattributed rather than dropped: the cash is real either way. Keyed on
    // the query's own `attributed` flag, never on the name — see the field.
    supplierId: row.attributed && row.supplier_id ? String(row.supplier_id) : null,
    supplierName: row.attributed && row.supplier_name !== null ? String(row.supplier_name) : null,
    paymentAmount,
    allocatedAmount: round2(allocatedAmount),
    unappliedAmount: round2(paymentAmount - allocatedAmount),
    status: String(row.status),
    reference: row.reference ? String(row.reference) : null,
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
