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
       AND NOT EXISTS (
         SELECT 1 FROM expense_claim_lines ecl
           JOIN expense_claims ec ON ec.id = ecl.claim_id AND ec.company_id = ecl.company_id
          WHERE ecl.source_document_id = cd.id
            AND ecl.company_id = cd.company_id
            AND ec.status NOT IN ('rejected', 'cancelled')
       )
    RETURNING cd.id`) as DbRow[];
  return rows.length === 1;
}

/**
 * Hand back a claim whose document produced nothing that is standing in the
 * ledger — discarding the DRAFT journal it produced, if it produced one.
 *
 * The posting routes claim the document before their first ledger write, and
 * `receipt-to-journal` only POSTS the journal it builds when
 * `shouldAutoPostReceipt` passes. Over R5 000, below 0.85 confidence, or on any
 * unreconciled warning — the MAJORITY of documents — it leaves a DRAFT and the
 * claim behind it. Measured before this function existed: confirm 400, reject
 * 400, re-post 400, and `reverseJournalEntry` throws "Can only reverse posted
 * entries" on the draft, with no route that deletes a journal entry. Every exit
 * closed, on the ordinary path, and the refusal's "Reverse the journal or
 * invoice first" was a remedy that did not apply.
 *
 * A draft is not in the ledger — it is on no report, in no balance, in no VAT
 * return — so discarding it destroys no accounting record; the captured
 * document it was read from is untouched and the operator re-posts from the
 * corrected data. What is NOT discardable is anything live: a posted journal
 * (reversal is its undo), an uncancelled supplier invoice, or a claim still in
 * flight. Those are checked FIRST and refused with nothing written, because
 * `withAuth` COMMITs a 4xx returned after a write.
 *
 * `AND status = 'draft'` on the DELETE is the same load-bearing predicate the
 * reversal cleanup carries: it is what makes this incapable of touching a
 * posted entry even if the liveness check above were wrong.
 * `gl_journal_lines` cascades from the header
 * (`gl_journal_lines_journal_entry_id_fkey ON DELETE CASCADE`).
 *
 * Returns true when the claim was released.
 */
export async function releaseUnpostedCaptureClaim(
  companyId: string,
  documentId: string,
): Promise<boolean> {
  const live = (await sql`
    SELECT 1 AS live
     WHERE EXISTS (
             SELECT 1 FROM gl_journal_entries je
              WHERE je.source_document_id = ${documentId}::uuid
                AND je.company_id = ${companyId}
                AND je.source = 'auto_expense_receipt'
                AND je.status <> 'draft'
                AND je.reversed_at IS NULL
           )
        OR EXISTS (
             SELECT 1 FROM supplier_invoices si
              WHERE si.source_document_id = ${documentId}::uuid
                AND si.company_id = ${companyId}
                AND si.status <> 'cancelled'
           )
        OR EXISTS (
             SELECT 1 FROM expense_claim_lines ecl
               JOIN expense_claims ec ON ec.id = ecl.claim_id AND ec.company_id = ecl.company_id
              WHERE ecl.source_document_id = ${documentId}::uuid
                AND ecl.company_id = ${companyId}
                AND ec.status NOT IN ('rejected', 'cancelled')
           )`) as DbRow[];
  if (live.length > 0) return false;

  await sql`
    DELETE FROM gl_journal_entries
     WHERE source_document_id = ${documentId}::uuid
       AND company_id = ${companyId}
       AND source = 'auto_expense_receipt'
       AND status = 'draft'`;

  return releaseCapturedDocumentPostingClaim(companyId, documentId);
}

/**
 * Release the documents a retired expense claim was holding.
 *
 * `post-expense`'s employee branch claims the captured document and creates a
 * claim; the claim's posting journal deliberately carries
 * `source_document_id = NULL` (a claim has many source documents), so
 * `reverseJournalEntry` never looks the document up and the reversal path
 * cannot be the undo here. Rejecting or cancelling the claim is — and until it
 * called this, a rejected claim left its document claimed forever, by
 * construction.
 *
 * Called AFTER the claim's status is written, so the claim itself no longer
 * counts as live in the predicates above.
 */
export async function releaseClaimDocuments(
  claimId: string,
  companyId: string,
): Promise<void> {
  const rows = (await sql`
    SELECT DISTINCT source_document_id FROM expense_claim_lines
     WHERE claim_id = ${claimId}::uuid
       AND company_id = ${companyId}
       AND source_document_id IS NOT NULL`) as DbRow[];
  for (const row of rows) {
    await releaseCapturedDocumentPostingClaim(companyId, String(row.source_document_id));
  }
}
