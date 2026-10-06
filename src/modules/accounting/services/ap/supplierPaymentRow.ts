/**
 * The one supplier_payments row -> SupplierPayment mapper, shared by the
 * create / read service and the approve, process and void workflows (which
 * kept a private copy until R-035 PR5 split approve out of them).
 */

import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import type { SupplierPayment } from '../../types/ap.types';

type Row = DbRow;

/** R-127: set only on a payment that settled a bill out of a bank-first provisional (migration 711). */
export type ProvisionalSettlementMark = { settlesProvisionalJeId?: string };

export function mapPaymentRow(row: Row): SupplierPayment & ProvisionalSettlementMark {
  return {
    id: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    supplierId: String(row.supplier_id),
    paymentDate: fmtDate(row.payment_date),
    totalAmount: Number(row.total_amount),
    paymentMethod: String(row.payment_method) as SupplierPayment['paymentMethod'],
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : undefined,
    reference: row.reference ? String(row.reference) : undefined,
    description: row.description ? String(row.description) : undefined,
    status: String(row.status) as SupplierPayment['status'],
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    batchId: row.batch_id ? String(row.batch_id) : undefined,
    createdBy: String(row.created_by),
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    processedAt: row.processed_at ? String(row.processed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
    settlesProvisionalJeId: row.settles_provisional_je_id ? String(row.settles_provisional_je_id) : undefined,
  };
}
