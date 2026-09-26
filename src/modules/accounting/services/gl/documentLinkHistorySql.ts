/**
 * The base fragment behind "which journal has this document ever been linked
 * to" — spliced (via the `sql` tag's LazyQuery embedding) into the pre-filing
 * over-claim report (`reports/vatInputSupportQuery.queryInputVatSupport`).
 *
 * Breaker round 2 (item 1): the report used to read only the CURRENTLY
 * ACTIVE `gl_journal_document_links` row (`unlinked_at IS NULL`). Unlinking a
 * document from journal A (still posted, its claim still standing) and
 * linking it to journal B laundered A's claim off the total and let B claim
 * freely — two real, still-posted claims totalling R2000 against a R1000
 * document. Fixed (chosen over "forbid unlinking" or an immutable
 * per-journal marker) by counting EVERY link row a document has ever had,
 * `unlinked_at` or not, when summing what it has been claimed against.
 *
 * NOT used by the write-side guard (`documentJournalClaimGuard.ts`) — see
 * that file's header for why its own, textually separate, active-only query
 * stays that way (unit-test mocking, and the reassignment this fragment's
 * "ever" semantics would otherwise wrongly block).
 */
import { sql } from '@/lib/neon';

/** Every (journal_entry_id, captured_document_id) link this company has ever recorded — active or not. */
export function allDocumentLinksSql(companyId: string) {
  return sql<{ journal_entry_id: string; captured_document_id: string }>`
    SELECT jdl.journal_entry_id, jdl.captured_document_id
    FROM gl_journal_document_links jdl
    WHERE jdl.company_id = ${companyId}::UUID
  `;
}
