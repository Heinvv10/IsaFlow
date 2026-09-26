/**
 * ONE shared fragment for "which journal has ever claimed this document" —
 * spliced (via the `sql` tag's LazyQuery embedding) into both the write-side
 * guard (`documentJournalClaimGuard.assertDocumentNotAlreadyPosted`) and the
 * pre-filing report (`reports/vatInputSupportQuery.queryInputVatSupport`), so
 * the two never drift on what counts as "this document backs that journal".
 *
 * Breaker round 2 (item 1): the OLD guard/report only read the CURRENTLY
 * ACTIVE `gl_journal_document_links` row (`unlinked_at IS NULL`). Unlinking a
 * document from journal A (still posted, its claim still standing) and
 * linking it to journal B laundered A's claim off the report and let B link
 * freely — two real, still-posted claims total R2000 against a R1000
 * document.
 *
 * Fix (chosen over "forbid unlinking" or an immutable per-journal marker):
 * count EVERY link row this company has ever created for a document,
 * `unlinked_at` or not. Unlinking still reassigns which document a journal is
 * CURRENTLY read as claiming (deliberately allowed — evidence gets
 * re-attached to the right entry) but never erases that the old journal once
 * claimed against it. `source_document_id` is immutable already, so it is
 * always "ever" by construction — no unlink path touches it.
 */
import { sql } from '@/lib/neon';

/**
 * Every (journal_entry_id, captured_document_id) link this company has ever
 * recorded — active or not. `unlinked_at` rides along so a caller that still
 * only cares about the currently-active link (the write-side guard's
 * `linkDocumentToJournal` — unlinking deliberately stays a normal, allowed
 * reassignment there, see the guard's own header) can filter to it, while the
 * over-claim report sums across every row regardless.
 */
export function allDocumentLinksSql(companyId: string) {
  return sql<{ journal_entry_id: string; captured_document_id: string; unlinked_at: Date | null }>`
    SELECT jdl.journal_entry_id, jdl.captured_document_id, jdl.unlinked_at
    FROM gl_journal_document_links jdl
    WHERE jdl.company_id = ${companyId}::UUID
  `;
}
