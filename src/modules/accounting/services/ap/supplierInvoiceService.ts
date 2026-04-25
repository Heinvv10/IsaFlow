/**
 * PRD-060: FibreFlow Accounting Module — Phase 2
 * Supplier Invoice Service
 */

import { sql, withTransaction, fmtDate } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  SupplierInvoice,
  SupplierInvoiceItem,
  SupplierInvoiceCreateInput,
  SupplierInvoiceStatus,
  InvoiceMatchStatus,
} from '../../types/ap.types';
import type { VatType } from '../../types/gl.types';
import { computeFingerprint } from '../capture/duplicateDetectionService';
import { resolvePendingAlertForInvoice } from '../capture/alertResolutionService';
type Row = DbRow;


interface InvoiceFilters {
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

const SORT_COLUMNS: Record<SupplierInvoiceSort, string> = {
  invoice_number: 'si.invoice_number',
  supplier_name: 's.name',
  reference: 'si.reference',
  invoice_date: 'si.invoice_date',
  total_amount: 'si.total_amount',
  balance: 'si.balance',
  status: 'si.status',
};

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
  s.name AS supplier_name, NULL::text AS po_number
`;

/**
 * Build the AND-joined WHERE fragment for the given filters. Only active
 * predicates are emitted so postgres can use the indexes on `(company_id,
 * status)`, `(supplier_id)`, etc. — the previous `(${p} IS NULL OR col=${p})`
 * shape was non-sargable.
 *
 * Built as a single `sql.unsafe(text, values)` LazyQuery so callers can
 * interpolate it once into the outer query. Predicate strings are *static*
 * literals — only validated/typed values go through `$N` placeholders, so
 * the unsafe call carries no injection risk.
 */
function buildInvoiceWhere(companyId: string, f: InvoiceFilters | undefined) {
  const values: unknown[] = [companyId];
  const conds: string[] = ['si.company_id = $1::UUID', 'si.deleted_at IS NULL'];

  function add(predicate: (n: number) => string, value: unknown) {
    values.push(value);
    conds.push(predicate(values.length));
  }

  if (f?.status) add((n) => `si.status = $${n}::text`, f.status);
  if (f?.supplierId) add((n) => `si.supplier_id = $${n}::uuid`, f.supplierId);
  if (f?.matchStatus) add((n) => `si.match_status = $${n}::text`, f.matchStatus);
  if (f?.fromDate) add((n) => `si.invoice_date >= $${n}::date`, f.fromDate);
  if (f?.toDate) add((n) => `si.invoice_date <= $${n}::date`, f.toDate);
  if (typeof f?.fromAmount === 'number') {
    add((n) => `si.total_amount >= $${n}::numeric`, f.fromAmount);
  }
  if (typeof f?.toAmount === 'number') {
    add((n) => `si.total_amount <= $${n}::numeric`, f.toAmount);
  }
  if (typeof f?.fromBalance === 'number') {
    add((n) => `si.balance >= $${n}::numeric`, f.fromBalance);
  }
  if (typeof f?.toBalance === 'number') {
    add((n) => `si.balance <= $${n}::numeric`, f.toBalance);
  }
  const trimmed = f?.search?.trim();
  if (trimmed) {
    values.push(`%${trimmed}%`);
    const n = values.length;
    conds.push(`(si.invoice_number ILIKE $${n} OR si.reference ILIKE $${n} OR si.notes ILIKE $${n} OR s.name ILIKE $${n})`);
  }

  return sql.unsafe(conds.join(' AND '), values);
}

function buildOrderBy(filters: InvoiceFilters | undefined): string {
  const sortKey: SupplierInvoiceSort = filters?.sort && SORT_COLUMNS[filters.sort]
    ? filters.sort
    : 'invoice_date';
  const sortColumn = SORT_COLUMNS[sortKey];
  const sortDir = filters?.sortOrder === 'asc' ? 'ASC' : 'DESC';
  // si.created_at as the tie-breaker is monotonic (insertion order); using
  // si.id alone falls back to UUIDv4-random ordering which jitters per render.
  return `ORDER BY ${sortColumn} ${sortDir} NULLS LAST, si.created_at ${sortDir}, si.id ${sortDir}`;
}

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
      LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE ${where}
      ${sql.unsafe(orderBy)}
      LIMIT ${safeLimit} OFFSET ${offset}
    `) as Row[];

    const countRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id
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
      LEFT JOIN suppliers s ON s.id = si.supplier_id
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

export async function getSupplierInvoiceById(companyId: string, 
  id: string
): Promise<(SupplierInvoice & { items: SupplierInvoiceItem[] }) | null> {
  try {
    const rows = (await sql`
      SELECT si.*, s.name AS supplier_name, NULL::text AS po_number
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.id = ${id} AND si.company_id = ${companyId}::UUID
    `) as Row[];
    if (rows.length === 0) return null;

    const itemRows = (await sql`
      SELECT sii.*, a.account_code, a.account_name
      FROM supplier_invoice_items sii
      LEFT JOIN gl_accounts a ON a.id = sii.gl_account_id
      WHERE sii.supplier_invoice_id = ${id}
      ORDER BY sii.created_at
    `) as Row[];

    return { ...mapInvoiceRow(rows[0]!), items: itemRows.map(mapItemRow) };
  } catch (err) {
    log.error('Failed to get supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function createSupplierInvoice(companyId: string, 
  input: SupplierInvoiceCreateInput,
  userId: string
): Promise<SupplierInvoice> {
  try {
    const invoiceTaxRate = input.taxRate ?? 15;
    let subtotal = 0;
    let totalTax = 0;

    const computedItems = input.items.map(item => {
      const lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
      const itemTaxRate = item.taxRate ?? invoiceTaxRate;
      const itemTax = Math.round(lineTotal * itemTaxRate / 100 * 100) / 100;
      subtotal += lineTotal;
      totalTax += itemTax;
      return { ...item, lineTotal, taxAmount: itemTax, taxRate: itemTaxRate };
    });

    subtotal = Math.round(subtotal * 100) / 100;
    totalTax = Math.round(totalTax * 100) / 100;
    const totalAmount = subtotal + totalTax;

    const dueDate = input.dueDate || calculateDueDate(input.invoiceDate, input.paymentTerms);

    // Currency fields — default to ZAR / 1.0 for functional currency pass-through
    const currencyCode = input.currencyCode?.trim().toUpperCase() || 'ZAR';
    const exchangeRate = (typeof input.exchangeRate === 'number' && input.exchangeRate > 0)
      ? input.exchangeRate : 1.0;
    const functionalTotal = Math.round(totalAmount * exchangeRate * 100) / 100;

    // Fetch supplier VAT number for duplicate fingerprint
    const [supplierVatRow] = (await sql`
      SELECT vat_number FROM suppliers
      WHERE id = ${input.supplierId}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    const supplierVatNumber: string | null = supplierVatRow?.vat_number ?? null;
    const fingerprint = computeFingerprint(supplierVatNumber, input.invoiceNumber, totalAmount);

    const invoiceRow = await withTransaction(async (tx) => {
      const rows = (await tx`
        INSERT INTO supplier_invoices (
          company_id, invoice_number, supplier_id, purchase_order_id, grn_id,
          invoice_date, due_date, subtotal, tax_rate, tax_amount,
          total_amount, payment_terms, reference, project_id,
          cost_center_id, notes, created_by,
          currency_code, exchange_rate, functional_total,
          duplicate_fingerprint
        ) VALUES (
          ${companyId}::UUID, ${input.invoiceNumber}, ${input.supplierId},
          ${input.purchaseOrderId || null}, ${input.grnId || null},
          ${input.invoiceDate}, ${dueDate || null},
          ${subtotal}, ${invoiceTaxRate}, ${totalTax}, ${totalAmount},
          ${input.paymentTerms || null}, ${input.reference || null},
          ${input.projectId || null}, ${input.costCenterId || null},
          ${input.notes || null}, ${userId}::UUID,
          ${currencyCode}, ${exchangeRate}, ${functionalTotal},
          ${fingerprint}
        ) RETURNING *
      `) as Row[];

      const invoiceId = String(rows[0]!.id);

      for (const item of computedItems) {
        await tx`
          INSERT INTO supplier_invoice_items (
            supplier_invoice_id, po_item_id, description, quantity,
            unit_price, tax_rate, tax_amount, line_total,
            gl_account_id, project_id, cost_center_id, vat_classification
          ) VALUES (
            ${invoiceId}::UUID, ${item.poItemId || null}, ${item.description},
            ${item.quantity}, ${item.unitPrice}, ${item.taxRate},
            ${item.taxAmount}, ${item.lineTotal},
            ${item.glAccountId || null}, ${item.projectId || null},
            ${item.costCenterId || null},
            ${item.vatClassification || (item.taxRate > 0 ? 'standard' : 'zero_rated')}
          )
        `;
      }

      return rows[0] as Row;
    });

    log.info('Created supplier invoice', { invoiceId: String(invoiceRow.id), invoiceNumber: input.invoiceNumber }, 'accounting');

    // Best-effort alert resolution — non-blocking
    resolvePendingAlertForInvoice(
      companyId,
      input.supplierId,
      String(invoiceRow.id),
      input.invoiceDate,
    ).catch((err: unknown) => {
      log.warn('resolvePendingAlertForInvoice failed (non-blocking)', { error: err }, 'accounting');
    });

    return mapInvoiceRow(invoiceRow);
  } catch (err) {
    log.error('Failed to create supplier invoice', { error: err }, 'accounting');
    throw err;
  }
}

// ── Workflow functions (re-exported from supplierInvoiceWorkflowService) ──────

export {
  approveSupplierInvoice,
  cancelSupplierInvoice,
  performThreeWayMatch,
} from './supplierInvoiceWorkflowService';

function calculateDueDate(invoiceDate: string, paymentTerms?: string): string | null {
  if (!paymentTerms) return null;
  const match = paymentTerms.match(/net(\d+)/i);
  if (!match) return null;
  const date = new Date(invoiceDate);
  date.setDate(date.getDate() + Number(match[1]));
  return date.toISOString().split('T')[0]!;
}

function mapInvoiceRow(row: Row): SupplierInvoice {
  return {
    id: String(row.id),
    invoiceNumber: String(row.invoice_number),
    supplierId: String(row.supplier_id),
    purchaseOrderId: row.purchase_order_id ? String(row.purchase_order_id) : undefined,
    grnId: row.grn_id ? String(row.grn_id) : undefined,
    invoiceDate: fmtDate(row.invoice_date),
    dueDate: row.due_date ? fmtDate(row.due_date) : undefined,
    receivedDate: row.received_date ? fmtDate(row.received_date) : undefined,
    subtotal: Number(row.subtotal),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
    totalAmount: Number(row.total_amount),
    amountPaid: Number(row.amount_paid),
    balance: Number(row.balance),
    paymentTerms: row.payment_terms ? String(row.payment_terms) : undefined,
    currency: String(row.currency),
    reference: row.reference ? String(row.reference) : undefined,
    status: String(row.status) as SupplierInvoice['status'],
    matchStatus: String(row.match_status) as SupplierInvoice['matchStatus'],
    projectId: row.project_id ? String(row.project_id) : undefined,
    costCenterId: row.cost_center_id ? String(row.cost_center_id) : undefined,
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    sageInvoiceId: row.sage_invoice_id ? String(row.sage_invoice_id) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    createdBy: String(row.created_by),
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
    poNumber: row.po_number ? String(row.po_number) : undefined,
  };
}

function mapItemRow(row: Row): SupplierInvoiceItem {
  return {
    id: String(row.id),
    supplierInvoiceId: String(row.supplier_invoice_id),
    poItemId: row.po_item_id ? String(row.po_item_id) : undefined,
    description: String(row.description),
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
    lineTotal: Number(row.line_total),
    glAccountId: row.gl_account_id ? String(row.gl_account_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    costCenterId: row.cost_center_id ? String(row.cost_center_id) : undefined,
    vatClassification: row.vat_classification ? String(row.vat_classification) as VatType : undefined,
    createdAt: String(row.created_at),
  };
}
