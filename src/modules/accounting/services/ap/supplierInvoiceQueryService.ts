/**
 * PRD-060: AP — Supplier Invoice read-side queries.
 * List / count / export paths. WHERE/ORDER-BY composers live in
 * supplierInvoiceWhereBuilder.ts. Mutations stay in supplierInvoiceService.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  SupplierInvoice,
  SupplierInvoiceStatus,
  InvoiceMatchStatus,
} from '../../types/ap.types';
import { mapInvoiceRow } from './supplierInvoiceMapper';
import {
  buildInvoiceWhere,
  buildOrderBy,
  PAY_RUN_LOOKAHEAD_DAYS,
} from './supplierInvoiceWhereBuilder';

// Re-export so existing consumers that import mapInvoiceRow from this module
// keep working without a source change.
export { mapInvoiceRow };

type Row = DbRow;

export interface InvoiceFilters {
  status?: SupplierInvoiceStatus;
  supplierId?: string;
  matchStatus?: InvoiceMatchStatus;
  search?: string;
  fromDate?: string;
  toDate?: string;
  fromAmount?: number;
  toAmount?: number;
  fromBalance?: number;
  toBalance?: number;
  sort?: SupplierInvoiceSort;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  // Accountant signal filters
  missingDocument?: boolean;
  possibleDuplicate?: boolean;
  dueThisWeek?: boolean;
  payRunReady?: boolean;
}

export type SupplierInvoiceSort =
  | 'invoice_number'
  | 'supplier_name'
  | 'reference'
  | 'invoice_date'
  | 'total_amount'
  | 'balance'
  | 'status';

export const SUPPLIER_INVOICE_SORT_KEYS: readonly SupplierInvoiceSort[] = [
  'invoice_number', 'supplier_name', 'reference', 'invoice_date',
  'total_amount', 'balance', 'status',
] as const;

// Hard cap on rows pulled by the export endpoint. Keeps a tenant with
// 100k invoices from monopolising a Node process and the connection pool.
export const SUPPLIER_INVOICE_EXPORT_CAP = 10_000;

const INVOICE_COLUMNS = `
  si.id, si.company_id, si.invoice_number, si.supplier_id,
  si.purchase_order_id, si.grn_id,
  si.invoice_date, si.due_date, si.received_date,
  si.subtotal, si.tax_rate, si.tax_amount, si.total_amount,
  si.amount_paid, si.balance, si.payment_terms,
  si.currency, si.reference, si.status, si.match_status,
  si.project_id, si.cost_center_id,
  si.gl_journal_entry_id, si.sage_invoice_id,
  si.notes, si.created_by, si.approved_by, si.approved_at,
  si.created_at, si.updated_at,
  s.name AS supplier_name, NULL::text AS po_number,
  -- Accountant signals
  (si.source_document_id IS NOT NULL) AS has_document,
  (si.purchase_order_id IS NOT NULL)  AS has_po,
  EXISTS (
    SELECT 1 FROM supplier_invoices dup
    WHERE dup.company_id = si.company_id
      AND dup.supplier_id = si.supplier_id
      AND dup.invoice_number = si.invoice_number
      AND dup.id <> si.id
      AND dup.deleted_at IS NULL
  ) AS is_possible_duplicate,
  (
    si.status IN ('approved', 'partially_paid')
    AND si.balance > 0
    AND (si.due_date IS NULL OR si.due_date <= CURRENT_DATE + INTERVAL '${PAY_RUN_LOOKAHEAD_DAYS} days')
  ) AS payment_run_eligible
`;

// Re-export builders so tests can import them directly.
export { buildInvoiceWhere, buildOrderBy };

export async function getSupplierInvoices(companyId: string, filters?: InvoiceFilters): Promise<{
  invoices: SupplierInvoice[];
  total: number;
}> {
  try {
    const safeLimit = Math.min(filters?.limit ?? 50, 200);
    const offset = filters?.offset || 0;
    const where = buildInvoiceWhere(companyId, filters);
    const orderBy = buildOrderBy(filters);

    // NOTE: purchase_orders table is not available in standalone accounting app.
    // po_number is returned as NULL; purchase_order_id column is kept for data integrity.
    const rows = (await sql`
      SELECT ${sql.unsafe(INVOICE_COLUMNS)}
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
      WHERE ${where}
      ${sql.unsafe(orderBy)}
      LIMIT ${safeLimit} OFFSET ${offset}
    `) as Row[];

    const countRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
      WHERE ${where}
    `) as Row[];

    return { invoices: rows.map(mapInvoiceRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get supplier invoices', { error: err }, 'accounting');
    throw err;
  }
}

/**
 * Returns count per status for the given company so the UI can render tab badges
 * in a single round-trip. Includes a synthetic 'all' bucket.
 */
export async function getSupplierInvoiceStatusCounts(companyId: string): Promise<Record<string, number>> {
  try {
    const rows = (await sql`
      SELECT status, COUNT(*) AS cnt
      FROM supplier_invoices
      WHERE company_id = ${companyId}::UUID AND deleted_at IS NULL
      GROUP BY status
    `) as Row[];
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = Number(r.cnt);
      counts[String(r.status)] = n;
      total += n;
    }
    counts.all = total;
    return counts;
  } catch (err) {
    log.error('Failed to get supplier invoice status counts', { error: err }, 'accounting');
    throw err;
  }
}

/**
 * Export-flavoured fetch: a single un-paginated query (capped at
 * SUPPLIER_INVOICE_EXPORT_CAP) honouring the same filters and sort as the list
 * endpoint. One query → MVCC snapshot consistency, no risk of skipped or
 * duplicated rows from concurrent inserts that LIMIT/OFFSET paging would have.
 */
export async function getSupplierInvoicesForExport(
  companyId: string,
  filters?: Omit<InvoiceFilters, 'limit' | 'offset'>,
): Promise<{ invoices: SupplierInvoice[]; truncated: boolean }> {
  try {
    const where = buildInvoiceWhere(companyId, filters);
    const orderBy = buildOrderBy(filters);
    const cap = SUPPLIER_INVOICE_EXPORT_CAP;
    const rows = (await sql`
      SELECT ${sql.unsafe(INVOICE_COLUMNS)}
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
      WHERE ${where}
      ${sql.unsafe(orderBy)}
      LIMIT ${cap + 1}
    `) as Row[];
    const truncated = rows.length > cap;
    return {
      invoices: (truncated ? rows.slice(0, cap) : rows).map(mapInvoiceRow),
      truncated,
    };
  } catch (err) {
    log.error('Failed to export supplier invoices', { error: err }, 'accounting');
    throw err;
  }
}
