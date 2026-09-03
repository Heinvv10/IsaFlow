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
type Row = DbRow;


export async function getAPAging(companyId: string, asAtDate?: string): Promise<AgingBucket[]> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();
    if (asAtDate && isNaN(asAt.getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }
    // fmtDate, never toISOString: on this UTC+2 host a Date round-trip reports
    // the previous day and would shift the as-at boundary.
    const asAtStr = asAtDate ?? fmtDate(asAt);

    const rows = (await sql`
      SELECT si.id, si.supplier_id AS entity_id, s.name AS entity_name,
        COALESCE(si.due_date, si.invoice_date) AS due_date,
        (si.due_date IS NULL) AS due_date_missing,
        si.total_amount,
        COALESCE(paid.amount, 0) AS amount_paid,
        (si.total_amount - COALESCE(paid.amount, 0)) AS balance
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      LEFT JOIN LATERAL (
        SELECT SUM(pa.amount_allocated) AS amount
        FROM payment_allocations pa
        JOIN supplier_payments sp ON sp.id = pa.payment_id
        WHERE pa.invoice_id = si.id
          AND sp.company_id = ${companyId}::UUID
          AND sp.status NOT IN ('draft', 'cancelled')
          AND sp.payment_date <= ${asAtStr}::date
      ) paid ON TRUE
      WHERE si.company_id = ${companyId}::UUID
        AND si.status NOT IN ('draft', 'cancelled')
        AND si.invoice_date <= ${asAtStr}::date
        AND (si.total_amount - COALESCE(paid.amount, 0)) > 0
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

    const supplierRows = (await sql`SELECT id, name FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    if (supplierRows.length === 0) throw new Error(`Supplier ${supplierId} not found`);

    const rows = (await sql`
      SELECT si.id, si.supplier_id AS entity_id, s.name AS entity_name,
        COALESCE(si.due_date, si.invoice_date) AS due_date,
        (si.due_date IS NULL) AS due_date_missing,
        si.invoice_number, si.total_amount,
        COALESCE(paid.amount, 0) AS amount_paid,
        (si.total_amount - COALESCE(paid.amount, 0)) AS balance
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      LEFT JOIN LATERAL (
        SELECT SUM(pa.amount_allocated) AS amount
        FROM payment_allocations pa
        JOIN supplier_payments sp ON sp.id = pa.payment_id
        WHERE pa.invoice_id = si.id
          AND sp.company_id = ${companyId}::UUID
          AND sp.status NOT IN ('draft', 'cancelled')
          AND sp.payment_date <= ${asAtStr}::date
      ) paid ON TRUE
      WHERE si.company_id = ${companyId}::UUID
        AND si.supplier_id = ${supplierId}::UUID
        AND si.status NOT IN ('draft', 'cancelled')
        AND si.invoice_date <= ${asAtStr}::date
        AND (si.total_amount - COALESCE(paid.amount, 0)) > 0
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
