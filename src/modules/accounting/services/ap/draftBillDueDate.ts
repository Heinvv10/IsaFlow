/**
 * The due date a supplier-bill DRAFT edit writes (payment-terms programme, Part A), for both ways a bill is edited:
 * PUT supplier-invoices-detail (`draftBillEditDueDate`, called inside `withContentEditorStamp`, so the row is already
 * locked) and the MCP `update_supplier_invoice` (`billEditDueDate`, called from its plan, on the row it locked).
 *
 * A terms-sourced due date follows a moved invoice date or supplier (shared/draftDueDate.ts), re-dated by the same
 * precedence as a new bill (`billDueDateSourced`: the bill's own chosen terms, the supplier's, the company default;
 * source per that resolver). The bill's own terms are the ones THIS edit sends, never the stored text: a stored
 * "Net 15" on a terms-sourced bill did not date it (the supplier's terms did), so it must not date it now.
 * `source` is null when the edit did not re-date: the UPDATE's own rule applies (a moved due date is hand-set, 962).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { redatedDueDate } from '../shared/draftDueDate';
import type { DueDateSource } from '../shared/dueDateSource';
import { billDueDateSourced } from './billDueDate';

/** The locked row's facts, dates as YYYY-MM-DD text. */
export interface StoredBillDates {
  supplierId: string;
  invoiceDate: string;
  dueDate: string | null;
  dueDateSource: unknown;
}

export interface BillDueDateEdit {
  supplierId?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  paymentTerms?: string | null;
}

export async function billEditDueDate(
  companyId: string, stored: StoredBillDates, edit: BillDueDateEdit,
): Promise<{ dueDate: string | null; source: DueDateSource | null }> {
  const given = edit.dueDate || null;
  const supplierId = edit.supplierId || stored.supplierId;
  const invoiceDate = edit.invoiceDate || stored.invoiceDate;
  const redated = await redatedDueDate({
    storedSource: stored.dueDateSource,
    moved: invoiceDate !== stored.invoiceDate || supplierId.toLowerCase() !== stored.supplierId.toLowerCase(),
    storedDueDate: stored.dueDate,
    givenDueDate: given,
    termsDate: async () => {
      const t = await billDueDateSourced(companyId, supplierId, invoiceDate, { paymentTerms: edit.paymentTerms });
      return { dueDate: t.dueDate, source: t.source };
    },
  });
  return redated ?? { dueDate: given, source: null };
}

/** The route's form: reads the bill (already locked by the caller) and decides. */
export async function draftBillEditDueDate(
  companyId: string, invoiceId: string, edit: BillDueDateEdit,
): Promise<{ dueDate: string | null; source: DueDateSource | null }> {
  const [row] = (await sql`
    SELECT supplier_id, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(due_date, 'YYYY-MM-DD') AS due_date,
           due_date_source, status
    FROM supplier_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
  `) as DbRow[];
  if (!row || !['draft', 'pending_approval'].includes(String(row.status))) return { dueDate: edit.dueDate || null, source: null };
  return billEditDueDate(companyId, {
    supplierId: String(row.supplier_id), invoiceDate: String(row.invoice_date),
    dueDate: row.due_date == null ? null : String(row.due_date), dueDateSource: row.due_date_source,
  }, edit);
}
