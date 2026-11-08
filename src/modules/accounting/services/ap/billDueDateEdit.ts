/**
 * The one change an approved bill accepts: its due date (payment-terms programme PR 2; Hein, 2026-11-05: due_date is
 * the single source of truth, hand-editable on an approved bill, date only, audited).
 *
 * Only an OPEN posted bill: approved or partially_paid, with something still owing. A draft or pending bill has its own editors; a paid or cancelled
 * one owes nothing. The due date is outside the approval digest (migration 708: it changes nothing posted or owed), so
 * the approval stands. Only due_date and due_date_source move ('manual'), and the history is the database's: migration
 * 962's capture records who, when, through which channel, and the date and source before and after.
 *
 * Runs in the request's transaction (withAuth): the bill row is locked, its status and dates read under the lock, and
 * the UPDATE names the same statuses, so a payment or cancellation committing first is seen, never overwritten.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { localDateFromISO } from '@/lib/dateUtils';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';
import { REAPPLY_EPS } from '../shared/reapplyTermsShared';

export const DUE_DATE_EDITABLE_STATUSES = ['approved', 'partially_paid'] as const;

export class BillDueDateEditRefusal extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'BillDueDateEditRefusal';
  }
}

export interface BillDueDateEditResult {
  id: string;
  invoiceNumber: string;
  dueDate: string;
  previousDueDate: string | null;
  dueDateSource: string;
  /** False when the bill already had this due date: nothing was written and no history row recorded. */
  changed: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function setApprovedBillDueDate(
  companyId: string, invoiceId: string, dueDate: unknown,
): Promise<BillDueDateEditResult> {
  if (typeof dueDate !== 'string' || !ISO_DATE.test(dueDate) || localDateFromISO(dueDate) === null) {
    throw new BillDueDateEditRefusal('dueDate must be a real date as YYYY-MM-DD', 400);
  }
  const row = await lockSupplierInvoiceForUpdate(companyId, invoiceId);
  // One reply for absent, foreign and soft-deleted: no existence oracle.
  if (!row || row.deleted_at) throw new BillDueDateEditRefusal('Supplier invoice not found', 404);
  const number = String(row.invoice_number);
  const status = String(row.status);
  if (!(DUE_DATE_EDITABLE_STATUSES as readonly string[]).includes(status)) {
    throw new BillDueDateEditRefusal(
      status === 'draft' || status === 'pending_approval'
        ? `Supplier invoice ${number} is ${status.replace('_', ' ')}: change its due date by editing the invoice.`
        : `Supplier invoice ${number} is ${status.replace('_', ' ')}: only an approved or part-paid invoice's due date can be changed.`,
      400,
    );
  }
  // Something must still be owing (the same test Re-apply uses): a fully paid bill's status can lag its balance.
  if (Number(row.total_amount ?? 0) - Number(row.amount_paid ?? 0) <= REAPPLY_EPS) {
    throw new BillDueDateEditRefusal(`Supplier invoice ${number} is fully paid: its due date can't be changed.`, 400);
  }
  const invoiceDate = fmtDate(row.invoice_date);
  if (dueDate < invoiceDate) {
    throw new BillDueDateEditRefusal(`The due date cannot be before the invoice date (${invoiceDate}).`, 400);
  }
  const previousDueDate = row.due_date ? fmtDate(row.due_date) : null;
  if (previousDueDate === dueDate) {
    return { id: invoiceId, invoiceNumber: number, dueDate, previousDueDate, dueDateSource: String(row.due_date_source), changed: false };
  }
  const [updated] = (await sql`
    UPDATE supplier_invoices
       SET due_date = ${dueDate}::DATE, due_date_source = 'manual', updated_at = NOW()
     WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
       AND status IN ('approved', 'partially_paid')
     RETURNING due_date_source
  `) as DbRow[];
  // Unreachable while the row lock holds; refuse rather than report a write that did not happen.
  if (!updated) throw new BillDueDateEditRefusal(`Supplier invoice ${number} changed while saving; reload and try again.`, 409);
  return { id: invoiceId, invoiceNumber: number, dueDate, previousDueDate, dueDateSource: String(updated.due_date_source), changed: true };
}
