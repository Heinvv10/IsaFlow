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
 *
 * VAT-gaps batch item 1 (migration 706): a document may ALSO back a posted
 * journal through `gl_journal_document_links` — the after-the-fact link a
 * manual/recurring/Sage-GL-import/migration journal uses, because those
 * journals were never "created from" the document (`source_document_id`
 * would be a false claim for them; see the migration header and
 * `journalDocumentLinkService.ts`). One document, one claim holds across
 * BOTH mechanisms: this guard now also refuses a document that is already an
 * ACTIVE link target, and `journalDocumentLinkService.linkDocumentToJournal`
 * calls this SAME function before creating a new link, so a document already
 * claimed via `source_document_id` cannot be linked either.
 *
 * Breaker round 2 (item 1): this guard's active-link check is UNCHANGED —
 * still "at most one ACTIVE link" — deliberately not extended to a
 * historical block. Unlinking stays a normal, allowed reassignment (a
 * document may need to move from a mis-captured entry to the right one), and
 * the reference regression scenario (unlink A, relink to B) requires the
 * relink itself to succeed so the REPORT can catch the resulting over-claim.
 * What changed is the report: `vatInputSupportQuery` now sums a document's
 * claimed VAT across EVERY journal it has ever been linked to (active or
 * not), inlined directly there — see that file's header for why a shared
 * `sql`-tag-building helper is NOT used for this scan: it breaks any caller
 * exercised by a test that mocks `sql` as a flat positional-queue stub —
 * `tests/unit/services/capture/evidenceAttachmentService.test.ts` for THIS
 * guard's own active-link check (caught before it was ever committed), and
 * `vatExceptionsService.test.ts`/`.recon.test.ts` (via
 * `vatExceptionsTestUtils.mockExceptionsSql`) for the report, which a first
 * attempt at sharing the fragment actually broke.
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

export class DocumentAlreadyLinkedRefusal extends Error {
  constructor(
    public readonly capturedDocumentId: string,
    public readonly journalEntryId: string,
  ) {
    super(
      `Captured document ${capturedDocumentId} is already linked to journal entry ${journalEntryId}. ` +
      'Unlink it first, or use a different document.',
    );
    this.name = 'DocumentAlreadyLinkedRefusal';
  }
}

/**
 * Refuses BEFORE any write when `sourceDocumentId` already backs a posted,
 * unreversed journal of `companyId` — via `source_document_id` OR an ACTIVE
 * row in `gl_journal_document_links`. Pass `excludeJournalId` when the caller
 * is about to UPDATE an existing journal row in place (evidence attach) or
 * create a link ON that same journal, so the check does not trip on the very
 * row it is claiming.
 */
export async function assertDocumentNotAlreadyPosted(
  companyId: string,
  sourceDocumentId: string,
  excludeJournalId?: string,
): Promise<void> {
  const exclude = excludeJournalId ?? NIL_UUID;
  const rows = (await sql`
    SELECT id FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID
      AND source_document_id = ${sourceDocumentId}::UUID
      AND status = 'posted'
      AND reversed_at IS NULL
      AND id <> ${exclude}::UUID
    LIMIT 1
  `) as DbRow[];
  if (rows.length > 0) {
    throw new DocumentAlreadyPostedRefusal(sourceDocumentId, String(rows[0]!.id));
  }

  const linkRows = (await sql`
    SELECT journal_entry_id FROM gl_journal_document_links
    WHERE company_id = ${companyId}::UUID
      AND captured_document_id = ${sourceDocumentId}::UUID
      AND unlinked_at IS NULL
      AND journal_entry_id <> ${exclude}::UUID
    LIMIT 1
  `) as DbRow[];
  if (linkRows.length > 0) {
    throw new DocumentAlreadyLinkedRefusal(sourceDocumentId, String(linkRows[0]!.journal_entry_id));
  }
}
