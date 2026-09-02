/**
 * Row -> CreditNote mapping, shared by the read and write halves of the
 * credit-note services. Extracted so neither has to import the other.
 */

import type { CreditNote, CreditNoteStatus } from '../../types/ar.types';

export function mapRow(row: Record<string, unknown>): CreditNote {
  return {
    id: String(row.id),
    creditNoteNumber: row.credit_note_number ? String(row.credit_note_number) : '',
    type: String(row.type) as CreditNote['type'],
    clientId: row.client_id ? String(row.client_id) : undefined,
    customerInvoiceId: row.customer_invoice_id ? String(row.customer_invoice_id) : undefined,
    supplierId: row.supplier_id ? String(row.supplier_id) : undefined,
    supplierInvoiceId: row.supplier_invoice_id ? String(row.supplier_invoice_id) : undefined,
    creditDate: String(row.credit_date),
    reason: row.reason ? String(row.reason) : undefined,
    subtotal: Number(row.subtotal),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
    totalAmount: Number(row.total_amount),
    appliedAmount: Number(row.applied_amount ?? 0),
    status: String(row.status) as CreditNoteStatus,
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    createdBy: String(row.created_by),
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    clientName: row.client_name ? String(row.client_name) : undefined,
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
  };
}
