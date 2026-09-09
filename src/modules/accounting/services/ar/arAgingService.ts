/**
 * PRD-060: FibreFlow Accounting Module — Phase 3
 * AR Aging Report Service
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateAgingBuckets } from '../../utils/aging';
import type { AgingBucket, AgingInvoice } from '../../types/ap.types';
import { fmtDate } from '@/lib/fmtDate';
import { getOpenDisputeTotals } from './disputeService';
import { rewindAmount, effectivePaidExpr } from '@/modules/accounting/services/shared/agingRewind';
type Row = DbRow;


/**
 * AR aging. The point-in-time reconstruction — how a past balance is derived,
 * every writer of amount_paid and whether it can be dated, and the four
 * documented limitations — lives in services/shared/agingRewind.ts, which both
 * this and the AP service build their rewind from. Read it before changing
 * anything about how `asAtDate` is handled here.
 */
export async function getARAging(companyId: string, asAtDate?: string): Promise<AgingBucket[]> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();
    if (asAtDate && isNaN(asAt.getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }
    // fmtDate, never toISOString: on this UTC+2 host a Date round-trip reports
    // the previous day, which would silently shift the as-at boundary.
    const asAtStr = asAtDate ?? fmtDate(asAt);
    // The rewind window's upper bound comes from the SAME clock as asAtStr,
    // not from CURRENT_DATE. The database session is UTC and the business runs
    // UTC+2, so between 22:00 and midnight SAST CURRENT_DATE is the PREVIOUS
    // day — settlement dated today would silently drop out of the window for
    // two hours every night, and the "window is empty when as-at is today"
    // invariant would hold only by two clocks happening to agree.
    const todayStr = fmtDate(new Date());

    const rows = (await sql`
      SELECT ci.id, COALESCE(ci.client_id, ci.customer_id) AS entity_id, c.name AS entity_name,
        COALESCE(ci.due_date, ci.invoice_date, ci.created_at::date) AS due_date,
        (ci.due_date IS NULL) AS due_date_missing,
        ci.total_amount,
        ${sql.unsafe(effectivePaidExpr('ar'))} AS amount_paid,
        (ci.total_amount - ${sql.unsafe(effectivePaidExpr('ar'))}) AS balance
      FROM customer_invoices ci
      JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr, todayStr, side: 'ar' })}
      ) unpaid ON TRUE
      WHERE ci.company_id = ${companyId}
        AND ci.status NOT IN ('draft', 'cancelled')
        -- A soft-deleted invoice is not a receivable. deleted_at is the only
        -- record that the document was deleted and it is never set to a future
        -- time, so IS NULL is the whole test.
        AND ci.deleted_at IS NULL
        AND COALESCE(ci.invoice_date, ci.created_at::date) <= ${asAtStr}::date
        AND (ci.total_amount - ${sql.unsafe(effectivePaidExpr('ar'))}) > 0
      -- POINT IN TIME. amount_paid on the invoice is a CURRENT snapshot, so
      -- reading it made asAtDate decorative: it only re-bucketed today's
      -- balances by age. What was owed on a past date is reconstructed from
      -- the allocation history instead — every customer_payments row carries a
      -- payment_date, and for real client companies the allocations reconcile
      -- to amount_paid exactly.
      --
      -- Status is NOT filtered to the open set here: an invoice that is paid
      -- TODAY was still outstanding on an earlier date, and filtering it out
      -- is what erased settled debt from historical aging. Only 'draft' and
      -- 'cancelled' are excluded; there is no 'void' status in this schema.
      -- See src/lib/constants/invoiceStatuses.ts for why aging is exempt from
      -- the open-status sets the live surfaces share.
      -- An invoice with no due date is still a debt. Filtering
      -- due_date IS NOT NULL here dropped 34 invoices worth R13,908,380.43
      -- from production's AR aging — not shown in a bucket, not in a total,
      -- and not reported as excluded. Every such row carries an invoice_date,
      -- so it is aged from that instead, which is conservative: an undated
      -- invoice reads as older than it may be, rather than vanishing.
      ORDER BY COALESCE(ci.due_date, ci.invoice_date, ci.created_at::date)
    `) as Row[];

    const invoiceIds = rows.map((r: Row) => String(r.id));
    const disputedTotals = await getOpenDisputeTotals(companyId, invoiceIds);

    const invoices: AgingInvoice[] = rows.map((r: Row) => ({
      id: String(r.id),
      entityId: String(r.entity_id),
      entityName: String(r.entity_name),
      dueDate: String(r.due_date),
      dueDateMissing: r.due_date_missing === true,
      totalAmount: Number(r.total_amount),
      amountPaid: Number(r.amount_paid),
      balance: Number(r.balance),
      disputedAmount: disputedTotals.get(String(r.id)) ?? 0,
    }));

    // Include unallocated credit notes as negative balances
    const cnRows = (await sql`
      SELECT cn.id, cn.client_id AS entity_id, c.name AS entity_name,
        cn.credit_date AS due_date, cn.total_amount, 0 AS amount_paid,
        -cn.total_amount AS balance
      FROM credit_notes cn
      JOIN customers c ON c.id = cn.client_id
      WHERE cn.company_id = ${companyId}
        AND cn.type = 'customer' AND cn.status = 'approved'
        AND cn.customer_invoice_id IS NULL
        -- A credit note granted after the as-at date had not reduced the
        -- customer's balance on that date.
        --
        -- This filter is currently INERT and kept only so it stays correct if
        -- the behaviour below changes: these rows are pushed with a NEGATIVE
        -- balance, and calculateAgingBuckets drops everything with balance <= 0,
        -- so an unallocated credit note never reaches a bucket at any as-at
        -- date. That AR aging does not net unallocated credit is pre-existing
        -- and out of scope here — it is noted so the next reader does not
        -- conclude from this filter that it does.
        AND cn.credit_date <= ${asAtStr}::date
    `) as Row[];

    for (const r of cnRows) {
      invoices.push({
        id: String(r.id),
        entityId: String(r.entity_id),
        entityName: String(r.entity_name),
        dueDate: String(r.due_date),
        totalAmount: Number(r.total_amount),
        amountPaid: Number(r.amount_paid),
        balance: Number(r.balance),
      });
    }

    return calculateAgingBuckets(invoices, asAt);
  } catch (err) {
    log.error('Failed to get AR aging', { error: err }, 'accounting');
    throw err;
  }
}

export async function getARAgingDetail(companyId: string, 
  clientId: string,
  asAtDate?: string
): Promise<{ client: { id: string; name: string }; invoices: AgingInvoice[]; buckets: AgingBucket | null }> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();
    // The other three aging entry points guard this; this one did not, so
    // ?as_at=lol reached Postgres and came back as a 22007 date-format error
    // instead of a readable refusal.
    if (asAtDate && isNaN(asAt.getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }
    const asAtStr = asAtDate ?? fmtDate(asAt);
    // The rewind window's upper bound comes from the SAME clock as asAtStr,
    // not from CURRENT_DATE. The database session is UTC and the business runs
    // UTC+2, so between 22:00 and midnight SAST CURRENT_DATE is the PREVIOUS
    // day — settlement dated today would silently drop out of the window for
    // two hours every night, and the "window is empty when as-at is today"
    // invariant would hold only by two clocks happening to agree.
    const todayStr = fmtDate(new Date());

    const clientRows = (await sql`SELECT id, name AS name FROM customers WHERE id = ${clientId}::UUID AND company_id = ${companyId}`) as Row[];
    if (clientRows.length === 0) throw new Error(`Client ${clientId} not found`);

    const rows = (await sql`
      SELECT ci.id, COALESCE(ci.client_id, ci.customer_id) AS entity_id, c.name AS entity_name,
        COALESCE(ci.due_date, ci.invoice_date, ci.created_at::date) AS due_date,
        (ci.due_date IS NULL) AS due_date_missing,
        ci.invoice_number, ci.total_amount,
        ${sql.unsafe(effectivePaidExpr('ar'))} AS amount_paid,
        (ci.total_amount - ${sql.unsafe(effectivePaidExpr('ar'))}) AS balance
      FROM customer_invoices ci
      JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr, todayStr, side: 'ar' })}
      ) unpaid ON TRUE
      WHERE ci.company_id = ${companyId}
        AND COALESCE(ci.client_id, ci.customer_id) = ${clientId}::UUID
        AND ci.status NOT IN ('draft', 'cancelled')
        -- A soft-deleted invoice is not a receivable. deleted_at is the only
        -- record that the document was deleted and it is never set to a future
        -- time, so IS NULL is the whole test.
        AND ci.deleted_at IS NULL
        AND COALESCE(ci.invoice_date, ci.created_at::date) <= ${asAtStr}::date
        AND (ci.total_amount - ${sql.unsafe(effectivePaidExpr('ar'))}) > 0
      -- An invoice with no due date is still a debt. Filtering
      -- due_date IS NOT NULL here dropped 34 invoices worth R13,908,380.43
      -- from production's AR aging — not shown in a bucket, not in a total,
      -- and not reported as excluded. Every such row carries an invoice_date,
      -- so it is aged from that instead, which is conservative: an undated
      -- invoice reads as older than it may be, rather than vanishing.
      ORDER BY COALESCE(ci.due_date, ci.invoice_date, ci.created_at::date)
    `) as Row[];

    const invoiceIds = rows.map((r: Row) => String(r.id));
    const disputedTotals = await getOpenDisputeTotals(companyId, invoiceIds);

    const invoices: AgingInvoice[] = rows.map((r: Row) => ({
      id: String(r.id),
      entityId: String(r.entity_id),
      entityName: String(r.entity_name),
      dueDate: String(r.due_date),
      dueDateMissing: r.due_date_missing === true,
      totalAmount: Number(r.total_amount),
      amountPaid: Number(r.amount_paid),
      balance: Number(r.balance),
      disputedAmount: disputedTotals.get(String(r.id)) ?? 0,
    }));

    const buckets = calculateAgingBuckets(invoices, asAt);
    return {
      client: { id: String(clientRows[0]!.id), name: String(clientRows[0]!.name) },
      invoices,
      buckets: buckets.length > 0 ? buckets[0]! : null,
    };
  } catch (err) {
    log.error('Failed to get AR aging detail', { clientId, error: err }, 'accounting');
    throw err;
  }
}
