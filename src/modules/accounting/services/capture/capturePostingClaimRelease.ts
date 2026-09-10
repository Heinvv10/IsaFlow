/**
 * Undoing a capture posting claim.
 *
 * `captureRowLock` takes the claim; this is the only thing that gives it back.
 * Separate file because the callers are: the generic journal reversal and the
 * supplier-invoice cancel, neither of which has any business importing a
 * module of `FOR UPDATE` helpers for the posting paths.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * Release the posting claim — but only once nothing the document produced is
 * still live in the ledger.
 *
 * Without this the fence was one-way: `posted_at` was stamped by four routes
 * and cleared by nothing, so `document-capture-action`'s "Document is already
 * posted to the ledger and cannot be confirmed. Reverse the journal or invoice
 * first." named a remedy that did not exist — reversing the journal left
 * `posted_at` exactly where it was, and the document stayed refused by every
 * route for good.
 *
 * The two NOT EXISTS clauses are the whole safety argument, and they are what
 * makes this callable from a generic reversal path: the claim comes back only
 * when NO unreversed capture posting journal and NO uncancelled supplier
 * invoice reference the document any more. A receipt posted down two routes and
 * reversed down one stays claimed, because one of its ledger rows is still
 * standing.
 *
 * Returns true when the claim was released.
 */
export async function releaseCapturedDocumentPostingClaim(
  companyId: string,
  documentId: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE captured_documents cd
       SET posted_at = NULL,
           updated_at = NOW()
     WHERE cd.id = ${documentId}::uuid
       AND cd.company_id = ${companyId}
       AND cd.posted_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM gl_journal_entries je
          WHERE je.source_document_id = cd.id
            AND je.company_id = cd.company_id
            AND je.source = 'auto_expense_receipt'
            AND je.reversed_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM supplier_invoices si
          WHERE si.source_document_id = cd.id
            AND si.company_id = cd.company_id
            AND si.status <> 'cancelled'
       )
    RETURNING cd.id`) as DbRow[];
  return rows.length === 1;
}
