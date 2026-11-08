/**
 * The one change an open customer invoice accepts: its due date (payment-terms programme, AR parity with
 * `ap/billDueDateEdit`; Hein, 2026-11-05: due_date is the single source of truth, hand-editable once posted, date only,
 * audited).
 *
 * Only an OPEN posted invoice: approved, sent, overdue or part-paid. A draft or pending invoice has its own editor; a
 * paid or cancelled one owes nothing. The due date is
 * outside the approval digest (migration 865), so the approval stands. Only due_date and due_date_source move
 * ('manual'); the history is the database's: migration 962's capture records who, when, through which channel, and the
 * date and source before and after.
 *
 * Runs in the request's transaction (withAuth): the invoice row is locked, its status and dates read under the lock, and
 * the UPDATE names the same statuses, so a payment or cancellation committing first is seen, never overwritten.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { localDateFromISO } from '@/lib/dateUtils';
import { lockCustomerInvoiceForUpdate } from './customerInvoiceRowLock';

export const INVOICE_DUE_DATE_EDITABLE_STATUSES = ['approved', 'sent', 'overdue', 'partially_paid'] as const;

export class InvoiceDueDateEditRefusal extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'InvoiceDueDateEditRefusal';
  }
}

export interface InvoiceDueDateEditResult {
  id: string;
  invoiceNumber: string;
  dueDate: string;
  previousDueDate: string | null;
  dueDateSource: string;
  /** False when the invoice already had this due date: nothing was written and no history row recorded. */
  changed: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function setOpenInvoiceDueDate(
  companyId: string, invoiceId: string, dueDate: unknown,
): Promise<InvoiceDueDateEditResult> {
  if (typeof dueDate !== 'string' || !ISO_DATE.test(dueDate) || localDateFromISO(dueDate) === null) {
    throw new InvoiceDueDateEditRefusal('dueDate must be a real date as YYYY-MM-DD', 400);
  }
  const row = await lockCustomerInvoiceForUpdate(companyId, invoiceId);
  // One reply for absent, foreign and soft-deleted: no existence oracle.
  if (!row || row.deleted_at) throw new InvoiceDueDateEditRefusal('Invoice not found', 404);
  const number = String(row.invoice_number);
  const status = String(row.status);
  if (!(INVOICE_DUE_DATE_EDITABLE_STATUSES as readonly string[]).includes(status)) {
    throw new InvoiceDueDateEditRefusal(
      status === 'draft' || status === 'pending_approval'
        ? `Invoice ${number} is ${status.replace('_', ' ')}: change its due date by editing the invoice.`
        : `Invoice ${number} is ${status.replace('_', ' ')}: only an approved, sent, overdue or part-paid invoice's due date can be changed.`,
      400,
    );
  }
  const invoiceDate = String(row.invoice_date);
  if (dueDate < invoiceDate) {
    throw new InvoiceDueDateEditRefusal(`The due date cannot be before the invoice date (${invoiceDate}).`, 400);
  }
  const previousDueDate = row.due_date ? String(row.due_date) : null;
  if (previousDueDate === dueDate) {
    return { id: invoiceId, invoiceNumber: number, dueDate, previousDueDate, dueDateSource: String(row.due_date_source), changed: false };
  }
  const [updated] = (await sql`
    UPDATE customer_invoices
       SET due_date = ${dueDate}::DATE, due_date_source = 'manual', updated_at = NOW()
     WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
       AND status = ANY(${[...INVOICE_DUE_DATE_EDITABLE_STATUSES]}::TEXT[])
     RETURNING due_date_source
  `) as DbRow[];
  // Unreachable while the row lock holds; refuse rather than report a write that did not happen.
  if (!updated) throw new InvoiceDueDateEditRefusal(`Invoice ${number} changed while saving; reload and try again.`, 409);
  return { id: invoiceId, invoiceNumber: number, dueDate, previousDueDate, dueDateSource: String(updated.due_date_source), changed: true };
}
