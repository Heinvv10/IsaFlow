/**
 * Reject a captured document (document-capture-action `reject`). Extracted from the route (300-line rule).
 *
 * Hein 2026-11-12 (migration 980): a reconciled bank line keeps its supporting documents. A rejected document stops
 * counting as one (bankLineDocumentSql drops rejected documents), so rejecting a document linked to a reconciled line
 * would strip that line's evidence: refused before any write. The line's session is taken FOR SHARE first
 * (documentRemovalRefused), so no completion can reconcile it between this check and the reject.
 */
import { sql } from '@/lib/neon';
import { documentRemovalRefused } from '../bank/reconciledCash';
import { isReconciliationCompleted } from '../bank/reconciliationSessionLock';

export const REJECT_REFUSED_RECONCILED_LINE = 'This document supports a reconciled bank line, so it cannot be '
  + 'rejected. Reopen that bank reconciliation first.';

export type RejectOutcome = { row: Record<string, unknown> } | { refused: 'reconciled_line' } | null;

async function onReconciledLine(companyId: string, documentId: string): Promise<boolean> {
  const [doc] = (await sql`
    SELECT matched_bank_tx_id::TEXT AS tx FROM captured_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid`) as Array<{ tx: string | null }>;
  if (!doc?.tx) return false;
  try {
    return await documentRemovalRefused(companyId, { bankTxId: doc.tx });
  } catch (err) {
    if (isReconciliationCompleted(err)) return true; // its line is in a completed reconciliation
    throw err;
  }
}

/** null: missing or posted (the route says which); refused: linked to a reconciled bank line. */
export async function rejectCapturedDocument(companyId: string, id: string, notes: string | null): Promise<RejectOutcome> {
  if (await onReconciledLine(companyId, id)) return { refused: 'reconciled_line' };
  const [row] = (await sql`
    UPDATE captured_documents
    SET status = 'rejected',
        notes = COALESCE(${notes}, notes)
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      AND posted_at IS NULL
    RETURNING *
  `) as Record<string, unknown>[];
  return row ? { row } : null;
}
