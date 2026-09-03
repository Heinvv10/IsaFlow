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
type Row = DbRow;


export async function getARAging(companyId: string, asAtDate?: string): Promise<AgingBucket[]> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();
    if (asAtDate && isNaN(asAt.getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }
    // fmtDate, never toISOString: on this UTC+2 host a Date round-trip reports
    // the previous day, which would silently shift the as-at boundary.
    const asAtStr = asAtDate ?? fmtDate(asAt);

    const rows = (await sql`
      SELECT ci.id, COALESCE(ci.client_id, ci.customer_id) AS entity_id, c.name AS entity_name,
        COALESCE(ci.due_date, ci.invoice_date, ci.created_at::date) AS due_date,
        (ci.due_date IS NULL) AS due_date_missing,
        ci.total_amount,
        COALESCE(paid.amount, 0) AS amount_paid,
        (ci.total_amount - COALESCE(paid.amount, 0)) AS balance
      FROM customer_invoices ci
      JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
      LEFT JOIN LATERAL (
        SELECT SUM(cpa.amount_allocated) AS amount
        FROM customer_payment_allocations cpa
        JOIN customer_payments cp ON cp.id = cpa.payment_id
        WHERE cpa.invoice_id = ci.id
          AND cp.company_id = ${companyId}
          AND cp.status NOT IN ('draft', 'cancelled')
          AND cp.payment_date <= ${asAtStr}::date
      ) paid ON TRUE
      WHERE ci.company_id = ${companyId}
        AND ci.status NOT IN ('draft', 'cancelled')
        AND COALESCE(ci.invoice_date, ci.created_at::date) <= ${asAtStr}::date
        AND (ci.total_amount - COALESCE(paid.amount, 0)) > 0
      -- POINT IN TIME. amount_paid on the invoice is a CURRENT snapshot, so
      -- reading it made asAtDate decorative: it only re-bucketed today's
      -- balances by age. What was owed on a past date is reconstructed from
      -- the allocation history instead — every customer_payments row carries a
      -- payment_date, and for real client companies the allocations reconcile
      -- to amount_paid exactly.
      --
      -- Status is NOT filtered to the open set here: an invoice that is paid
      -- TODAY was still outstanding on an earlier date, and filtering it out
      -- is what erased settled debt from historical aging. Only never-issued
      -- and voided invoices are excluded.
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
    const asAtStr = asAtDate ?? fmtDate(asAt);

    const clientRows = (await sql`SELECT id, name AS name FROM customers WHERE id = ${clientId}::UUID AND company_id = ${companyId}`) as Row[];
    if (clientRows.length === 0) throw new Error(`Client ${clientId} not found`);

    const rows = (await sql`
      SELECT ci.id, COALESCE(ci.client_id, ci.customer_id) AS entity_id, c.name AS entity_name,
        COALESCE(ci.due_date, ci.invoice_date, ci.created_at::date) AS due_date,
        (ci.due_date IS NULL) AS due_date_missing,
        ci.invoice_number, ci.total_amount,
        COALESCE(paid.amount, 0) AS amount_paid,
        (ci.total_amount - COALESCE(paid.amount, 0)) AS balance
      FROM customer_invoices ci
      JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
      LEFT JOIN LATERAL (
        SELECT SUM(cpa.amount_allocated) AS amount
        FROM customer_payment_allocations cpa
        JOIN customer_payments cp ON cp.id = cpa.payment_id
        WHERE cpa.invoice_id = ci.id
          AND cp.company_id = ${companyId}
          AND cp.status NOT IN ('draft', 'cancelled')
          AND cp.payment_date <= ${asAtStr}::date
      ) paid ON TRUE
      WHERE ci.company_id = ${companyId}
        AND COALESCE(ci.client_id, ci.customer_id) = ${clientId}::UUID
        AND ci.status NOT IN ('draft', 'cancelled')
        AND COALESCE(ci.invoice_date, ci.created_at::date) <= ${asAtStr}::date
        AND (ci.total_amount - COALESCE(paid.amount, 0)) > 0
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
