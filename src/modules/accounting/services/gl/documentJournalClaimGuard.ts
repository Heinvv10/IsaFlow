/**
 * One document, one claim, at the GL write side.
 *
 * `captured_documents.posted_at` already fences the CAPTURE posting routes
 * (see `capture/.claude.md`), but `gl_journal_entries.source_document_id` has
 * writers outside that fence — the manual `POST /api/accounting/journal-entries`
 * route, and the two evidence-attach paths that stamp it onto a PRE-EXISTING
 * bank-first provisional journal after the fact. This is the lower-level
 * backstop: whatever the caller is, a captured document may back at most one
 * POSTED, UNREVERSED journal of its own company at a time.
 *
 * A DRAFT journal referencing the document never blocks — only a posted one
 * does, because a draft has not yet claimed anything financially. A reversed
 * original (`reversed_at` set) never blocks either: `reverseJournalEntry`
 * leaves the original `status = 'posted'` (standard-accounting reversal, see
 * journalEntryPostingService.ts) but stamps `reversed_at`, and that is what
 * frees the document for reuse — not a status flip.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export class DocumentAlreadyPostedRefusal extends Error {
  constructor(
    public readonly sourceDocumentId: string,
    public readonly journalEntryId: string,
  ) {
    super(
      `Captured document ${sourceDocumentId} is already referenced by a posted, ` +
      `unreversed journal entry (${journalEntryId}). Reverse it first, or use a different document.`,
    );
    this.name = 'DocumentAlreadyPostedRefusal';
  }
}

/**
 * Refuses BEFORE any write when `sourceDocumentId` already backs a posted,
 * unreversed journal of `companyId`. Pass `excludeJournalId` when the caller
 * is about to UPDATE an existing journal row in place (evidence attach), so
 * the check does not trip on the very row it is claiming.
 */
export async function assertDocumentNotAlreadyPosted(
  companyId: string,
  sourceDocumentId: string,
  excludeJournalId?: string,
): Promise<void> {
  const rows = (await sql`
    SELECT id FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID
      AND source_document_id = ${sourceDocumentId}::UUID
      AND status = 'posted'
      AND reversed_at IS NULL
      AND id <> ${excludeJournalId ?? NIL_UUID}::UUID
    LIMIT 1
  `) as DbRow[];
  if (rows.length > 0) {
    throw new DocumentAlreadyPostedRefusal(sourceDocumentId, String(rows[0]!.id));
  }
}
