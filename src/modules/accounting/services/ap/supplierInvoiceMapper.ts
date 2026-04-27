/**
 * Row-to-domain mapper for supplier_invoices SELECT results.
 *
 * Extracted from supplierInvoiceQueryService.ts to keep that file under the
 * 300-line project cap while adding the accountant-signal columns.
 */

import { fmtDate } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { SupplierInvoice } from '../../types/ap.types';

type Row = DbRow;

/**
 * Map a raw Neon/Supabase row to the typed SupplierInvoice domain object.
 * Boolean columns from Postgres arrive as `true`/`false` (JS booleans) via
 * the driver, but may occasionally arrive as the string `'t'` when nested
 * inside CASE or computed expressions — handle both shapes defensively.
 */
export function mapInvoiceRow(row: Row): SupplierInvoice {
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
    hasDocument: row.has_document === true || row.has_document === 't',
    hasPo: row.has_po === true || row.has_po === 't',
    isPossibleDuplicate: row.is_possible_duplicate === true || row.is_possible_duplicate === 't',
    paymentRunEligible: row.payment_run_eligible === true || row.payment_run_eligible === 't',
  };
}
