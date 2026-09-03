/**
 * PRD-060: FibreFlow Accounting Module — Phase 2
 * AP Aging Report Service
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateAgingBuckets } from '../../utils/aging';
import type { AgingBucket, AgingInvoice } from '../../types/ap.types';
import { fmtDate } from '@/lib/fmtDate';
import { rewindAmount, effectivePaidExpr } from '@/modules/accounting/services/shared/agingRewind';
type Row = DbRow;


/**
 * Settlement AFTER the as-at date, to be rewound. Anchored on
 * supplier_invoices.amount_paid rather than rebuilt from allocations:
 * anything that settles an invoice without leaving a dated trail would
 * otherwise make it reappear at full face value. See the AR service
 * for the full reasoning and the measurement behind it.
 * 
 * applied_amount, not total_amount — creditNoteApproveService applies
 * MIN(total, outstanding) and leaves the excess unapplied. The column
 * is NOT NULL DEFAULT 0; a note at 0 reduced nothing to rewind.
 * 
 * 
 * 
 * AND ONE MORE BOUND ON THAT CLAIM. Anchoring inherits whatever
 * amount_paid says, including where it has been LOWERED after the
 * fact. On the 40 production invoices where dated allocations exceed
 * amount_paid, the historical figure carries the same overstatement
 * the LIVE report already carries: the live report says R483,266.76
 * for those invoices while their allocations say R358,306.39. This
 * code does not introduce that gap and does not widen it — it
 * reproduces the live ledger at an earlier date, which is the whole
 * point of anchoring — but it does not correct it either, so a
 * historical balance is not guaranteed to err only downwards.
 * 
 * The root cause is bank-match-confirm writing amount_paid absolutely
 * and clobbering what the allocation paths accumulated. That is a data
 * integrity defect in the settlement path, not in this report, and it
 * is worth fixing there. All 40 are the demo company; no real client
 * invoice is affected.
 * ONE CASE THIS DOES NOT COVER, stated rather than glossed. A payment
 * later CANCELLED keeps its allocation row but is excluded from the
 * rewind by the status filter, and amount_paid has already been
 * reduced. So for a date between the payment and its cancellation the
 * invoice reads as outstanding when it was in fact settled — the one
 * shape where this report can overstate a historical debt. There is no
 * cancellation date on customer_payments or supplier_payments to
 * distinguish it by (only updated_at, which any edit touches), so it
 * cannot be fixed without a schema change. Production exposure is 5
 * payments totalling R5,462.50, which does not justify one.
 * There is no supplier write-off table; customer_write_offs is the
 * only one in this schema, so AP has no third branch.
 */
export async function getAPAging(companyId: string, asAtDate?: string): Promise<AgingBucket[]> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();
    if (asAtDate && isNaN(asAt.getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }
    // fmtDate, never toISOString: on this UTC+2 host a Date round-trip reports
    // the previous day and would shift the as-at boundary.
    const asAtStr = asAtDate ?? fmtDate(asAt);
    // The rewind window's upper bound comes from the SAME clock as asAtStr,
    // not from CURRENT_DATE. The database session is UTC and the business runs
    // UTC+2, so between 22:00 and midnight SAST CURRENT_DATE is the PREVIOUS
    // day — settlement dated today would silently drop out of the window for
    // two hours every night, and the "window is empty when as-at is today"
    // invariant would hold only by two clocks happening to agree.
    const todayStr = fmtDate(new Date());

    const rows = (await sql`
      SELECT si.id, si.supplier_id AS entity_id, s.name AS entity_name,
        COALESCE(si.due_date, si.invoice_date) AS due_date,
        (si.due_date IS NULL) AS due_date_missing,
        si.total_amount,
        ${sql.unsafe(effectivePaidExpr('ap'))} AS amount_paid,
        (si.total_amount - ${sql.unsafe(effectivePaidExpr('ap'))}) AS balance
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr, todayStr, side: 'ap' })}
      ) unpaid ON TRUE
      WHERE si.company_id = ${companyId}::UUID
        AND si.status NOT IN ('draft', 'cancelled')
        AND si.invoice_date <= ${asAtStr}::date
        AND (si.total_amount - ${sql.unsafe(effectivePaidExpr('ap'))}) > 0
      -- Same omission as AR, and larger: 357 supplier invoices worth
      -- R37,703,816.94 — a third of all open payables — were absent from the
      -- aging because they carry no due date. Aged from invoice_date instead.
      ORDER BY COALESCE(si.due_date, si.invoice_date)
    `) as Row[];

    const invoices: AgingInvoice[] = rows.map((r: Row) => ({
      id: String(r.id),
      entityId: String(r.entity_id),
      entityName: String(r.entity_name),
      dueDate: String(r.due_date),
      dueDateMissing: r.due_date_missing === true,
      totalAmount: Number(r.total_amount),
      amountPaid: Number(r.amount_paid),
      balance: Number(r.balance),
    }));

    return calculateAgingBuckets(invoices, asAt);
  } catch (err) {
    log.error('Failed to get AP aging', { error: err }, 'accounting');
    throw err;
  }
}

export async function getAPAgingDetail(companyId: string, 
  supplierId: string,
  asAtDate?: string
): Promise<{ supplier: { id: string; name: string }; invoices: AgingInvoice[]; buckets: AgingBucket | null }> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();
    if (asAtDate && isNaN(asAt.getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }
    // fmtDate, never toISOString: on this UTC+2 host a Date round-trip reports
    // the previous day and would shift the as-at boundary.
    const asAtStr = asAtDate ?? fmtDate(asAt);
    // The rewind window's upper bound comes from the SAME clock as asAtStr,
    // not from CURRENT_DATE. The database session is UTC and the business runs
    // UTC+2, so between 22:00 and midnight SAST CURRENT_DATE is the PREVIOUS
    // day — settlement dated today would silently drop out of the window for
    // two hours every night, and the "window is empty when as-at is today"
    // invariant would hold only by two clocks happening to agree.
    const todayStr = fmtDate(new Date());

    const supplierRows = (await sql`SELECT id, name FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    if (supplierRows.length === 0) throw new Error(`Supplier ${supplierId} not found`);

    const rows = (await sql`
      SELECT si.id, si.supplier_id AS entity_id, s.name AS entity_name,
        COALESCE(si.due_date, si.invoice_date) AS due_date,
        (si.due_date IS NULL) AS due_date_missing,
        si.invoice_number, si.total_amount,
        ${sql.unsafe(effectivePaidExpr('ap'))} AS amount_paid,
        (si.total_amount - ${sql.unsafe(effectivePaidExpr('ap'))}) AS balance
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr, todayStr, side: 'ap' })}
      ) unpaid ON TRUE
      WHERE si.company_id = ${companyId}::UUID
        AND si.supplier_id = ${supplierId}::UUID
        AND si.status NOT IN ('draft', 'cancelled')
        AND si.invoice_date <= ${asAtStr}::date
        AND (si.total_amount - ${sql.unsafe(effectivePaidExpr('ap'))}) > 0
      -- Undated invoices belong here for the same reason they belong in the
      -- summary. A drill-down that omits them contradicts the total it drills
      -- into, which is worse than the original omission because it reads as a
      -- reconciled figure.
      ORDER BY COALESCE(si.due_date, si.invoice_date)
    `) as Row[];

    const invoices: AgingInvoice[] = rows.map((r: Row) => ({
      id: String(r.id),
      entityId: String(r.entity_id),
      entityName: String(r.entity_name),
      dueDate: String(r.due_date),
      dueDateMissing: r.due_date_missing === true,
      totalAmount: Number(r.total_amount),
      amountPaid: Number(r.amount_paid),
      balance: Number(r.balance),
    }));

    const buckets = calculateAgingBuckets(invoices, asAt);

    return {
      supplier: { id: String(supplierRows[0]!.id), name: String(supplierRows[0]!.name) },
      invoices,
      buckets: buckets.length > 0 ? buckets[0]! : null,
    };
  } catch (err) {
    log.error('Failed to get AP aging detail', { supplierId, error: err }, 'accounting');
    throw err;
  }
}
