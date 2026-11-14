/**
 * The one read of a document a credit note is applied to by name — the
 * customer invoice for a customer note, the supplier bill for a supplier note —
 * shared by `apply_credit_note` and `adjust_credit_note_application` so the two
 * agree on what "this document" and "its outstanding balance" mean.
 *
 * Company-scoped and soft-delete-aware: an absent row and another tenant's row
 * read the same (null), so neither caller can become an existence oracle, and a
 * deleted document (journal reversed) is never credited.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { CreditNoteSide } from './creditNoteFifo';

/** `invoice_number`, `status`, `owner_id` (the counterparty), `amount_paid`, `outstanding`. */
export async function readCreditNoteDocument(
  companyId: string,
  side: CreditNoteSide,
  invoiceId: string,
): Promise<DbRow | null> {
  const rows = (side === 'customer'
    ? await sql`
        SELECT invoice_number, status, COALESCE(client_id, customer_id) AS owner_id,
               COALESCE(amount_paid, 0) AS amount_paid,
               (total_amount - COALESCE(amount_paid, 0)) AS outstanding
        FROM customer_invoices
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL`
    : await sql`
        SELECT invoice_number, status, supplier_id AS owner_id,
               COALESCE(amount_paid, 0) AS amount_paid,
               (total_amount - COALESCE(amount_paid, 0)) AS outstanding
        FROM supplier_invoices
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL`) as DbRow[];
  return rows[0] ?? null;
}
