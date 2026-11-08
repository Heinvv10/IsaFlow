/**
 * The due date a supplier-bill DRAFT edit writes (payment-terms programme, Part A; PUT supplier-invoices-detail).
 * Called inside `withContentEditorStamp`, so the bill row is already locked and what is read here is what the UPDATE
 * that follows overwrites. A terms-sourced due date follows a moved invoice date (shared/draftDueDate.ts), re-dated by
 * the same precedence as a new bill (`billDueDateSourced`: the bill's own chosen terms, the supplier's, the default).
 * `source` is null when the edit did not re-date: the UPDATE's own rule applies (a moved due date is hand-set, 962).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { redatedDueDate } from '../shared/draftDueDate';
import type { DueDateSource } from '../shared/dueDateSource';
import { billDueDateSourced } from './billDueDate';

export async function draftBillEditDueDate(
  companyId: string,
  invoiceId: string,
  edit: { invoiceDate?: string | null; dueDate?: string | null; paymentTerms?: string | null },
): Promise<{ dueDate: string | null; source: DueDateSource | null }> {
  const given = edit.dueDate || null;
  const [row] = (await sql`
    SELECT supplier_id, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(due_date, 'YYYY-MM-DD') AS due_date,
           due_date_source, payment_terms, status
    FROM supplier_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
  `) as DbRow[];
  if (!row || !['draft', 'pending_approval'].includes(String(row.status))) return { dueDate: given, source: null };
  const invoiceDate = edit.invoiceDate || String(row.invoice_date);
  const redated = await redatedDueDate({
    storedSource: row.due_date_source,
    moved: invoiceDate !== String(row.invoice_date),
    storedDueDate: row.due_date == null ? null : String(row.due_date),
    givenDueDate: given,
    termsDate: async () => {
      const t = await billDueDateSourced(companyId, String(row.supplier_id), invoiceDate, { paymentTerms: edit.paymentTerms || row.payment_terms });
      return { dueDate: t.dueDate, source: t.source };
    },
  });
  return redated ?? { dueDate: given, source: null };
}
