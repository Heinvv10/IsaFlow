/**
 * VAT-gaps batch item 1: link a captured document to a POSTED journal that
 * cannot carry `source_document_id` (manual, recurring, Sage-GL-import,
 * migration journals — see migration 706's header and
 * `documentJournalClaimGuard.ts`). The pre-filing input-VAT support check
 * (`reports/vatInputSupport.ts`) reads this link the same way it reads
 * `source_document_id`: linking a tax invoice re-classifies the journal
 * against the document's own VAT (fully supported, `amount_mismatch`, or
 * `document_over_claimed`), moving it off whichever list it was in —
 * `unsupportedInputVat` (blocking) or `inputVatWithoutTaxInvoice` (warning).
 *
 * Same write permission as any other journal edit (`withWriteAccess`, no
 * extra role) — this does not change what the journal posted, only what
 * evidences it.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { journalStandsFragment, journalStandsUnbrokenFragment } from '../shared/journalInForceAsAt';
import { brokenChainMessage, findJournalChainHead } from '../shared/journalChainHead';
import { logAuditOrThrow } from '../core/auditTrailService';
import { isBeingRead, STALE_AFTER_MINUTES, STILL_BEING_READ } from '../capture/captureReadState';
import {
  assertDocumentNotAlreadyPosted, DocumentAlreadyPostedRefusal, DocumentAlreadyLinkedRefusal,
} from './documentJournalClaimGuard';

/**
 * Whether `err` is the migration-706 partial unique index firing: a
 * concurrent link on the SAME document won the race between this call's own
 * `assertDocumentNotAlreadyPosted` read and its INSERT. Matching the named
 * constraint (not bare 23505) keeps this from swallowing a future, unrelated
 * duplicate on this table under the same wrong message.
 */
function isConcurrentActiveLinkConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'uq_gl_journal_document_links_active_document';
}

export class JournalDocumentLinkRefusal extends Error {
  readonly code = 'JOURNAL_DOCUMENT_LINK_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'JournalDocumentLinkRefusal';
  }
}

export interface JournalDocumentLink {
  id: string;
  journalEntryId: string;
  capturedDocumentId: string;
  linkedBy: string;
  linkedAt: string;
  reason: string;
}

function mapLink(r: DbRow): JournalDocumentLink {
  return {
    id: String(r.id),
    journalEntryId: String(r.journal_entry_id),
    capturedDocumentId: String(r.captured_document_id),
    linkedBy: String(r.linked_by),
    linkedAt: r.linked_at instanceof Date ? r.linked_at.toISOString() : String(r.linked_at),
    reason: String(r.reason),
  };
}

/**
 * The company's own journal, posted and standing by its reversal chain (D8: one
 * reversed and re-reversed is back in the ledger) — else `null` (no existence oracle).
 */
async function loadLinkableJournal(companyId: string, journalEntryId: string): Promise<{ id: string } | null> {
  const rows = (await sql`
    SELECT je.id FROM gl_journal_entries je
    WHERE je.id = ${journalEntryId}::UUID AND je.company_id = ${companyId}::UUID
      AND je.status = 'posted' AND ${journalStandsUnbrokenFragment('je.id', companyId)}
  `) as DbRow[];
  if (!rows[0]) return null;
  // The fragment sees a broken ROOT only; a stamp with no contra further down, or a loop, is found by the walk.
  const chain = await findJournalChainHead(companyId, journalEntryId); // D8 round 6, brk-d8b F3
  if (chain?.kind === 'broken') throw new JournalDocumentLinkRefusal(brokenChainMessage(journalEntryId, chain));
  return { id: String(rows[0].id) };
}

/** The company's own document with its read columns, or null (no existence oracle for another tenant's). */
async function loadCompanyDocument(companyId: string, capturedDocumentId: string): Promise<DbRow | null> {
  const rows = (await sql`
    SELECT id, read_state, read_heartbeat_at, created_at FROM captured_documents
    WHERE id = ${capturedDocumentId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows[0] ?? null;
}

/**
 * Link a captured document to a posted, unreversed journal of the same
 * company. Refuses BEFORE any write: the journal must exist and be posted +
 * unreversed, the document must belong to the company, and the document must
 * not already back a claim (via `source_document_id` OR another active link
 * — `assertDocumentNotAlreadyPosted` checks both, in the same direction the
 * classifier reads them).
 */
export async function linkDocumentToJournal(
  companyId: string,
  journalEntryId: string,
  capturedDocumentId: string,
  userId: string,
  reason: string,
): Promise<JournalDocumentLink> {
  const why = reason.trim();
  if (!why) throw new JournalDocumentLinkRefusal('A reason is required to link a document to a journal.');

  const journal = await loadLinkableJournal(companyId, journalEntryId);
  if (!journal) throw new JournalDocumentLinkRefusal('Journal entry not found, not posted, or reversed.');

  const document = await loadCompanyDocument(companyId, capturedDocumentId);
  if (!document) throw new JournalDocumentLinkRefusal('Captured document not found.');
  // An upload still being read has no extraction (and so no VAT) yet; reading -> done is one-way, so a plain read is safe.
  if (isBeingRead(document)) throw new JournalDocumentLinkRefusal(STILL_BEING_READ);

  // Both directions of "one document, one claim": already backing another
  // posted journal via source_document_id, or already an active link. Both
  // throws are pre-write here — wrap them so every caller (API route, MCP
  // tool) can catch this one refusal type and answer 400, rather than the
  // guard's own error reaching an uncaught 500.
  try {
    await assertDocumentNotAlreadyPosted(companyId, capturedDocumentId);
  } catch (err) {
    if (err instanceof DocumentAlreadyPostedRefusal || err instanceof DocumentAlreadyLinkedRefusal) {
      throw new JournalDocumentLinkRefusal(err.message);
    }
    throw err;
  }

  // The sequential pre-check above cannot see a link committed by another
  // request AFTER it read and BEFORE this INSERT — only the partial unique
  // index catches that race. Run the INSERT in its own savepoint: a caught
  // SQL error inside a transaction otherwise poisons the whole transaction,
  // and `withSavepoint` is what leaves it usable for the caller's own COMMIT.
  let rows: DbRow[];
  try {
    rows = (await withSavepoint('journal_document_link_insert', () => sql`
      INSERT INTO gl_journal_document_links (company_id, journal_entry_id, captured_document_id, linked_by, reason)
      VALUES (${companyId}::UUID, ${journalEntryId}::UUID, ${capturedDocumentId}::UUID, ${userId}, ${why})
      RETURNING id, journal_entry_id, captured_document_id, linked_by, linked_at, reason
    `)) as DbRow[];
  } catch (err) {
    if (isConcurrentActiveLinkConflict(err)) {
      throw new JournalDocumentLinkRefusal(`Captured document ${capturedDocumentId} is already linked to another journal entry. Unlink it first, or use a different document.`);
    }
    throw err;
  }
  const link = mapLink(rows[0]!);

  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'gl_journal_entry', entityId: journalEntryId,
    changes: {
      fields: [{ field: 'linked_document', old: null, new: capturedDocumentId, label: 'Tax invoice linked' }],
      metadata: { reason: why, capturedDocumentId },
    },
  });
  log.info('Document linked to journal', { companyId, journalEntryId, capturedDocumentId }, 'journalDocumentLinkService');
  return link;
}

/** Every ACTIVE link on a journal (normally at most one; nothing forbids more). */
export async function getActiveLinksForJournal(companyId: string, journalEntryId: string): Promise<JournalDocumentLink[]> {
  const rows = (await sql`
    SELECT id, journal_entry_id, captured_document_id, linked_by, linked_at, reason
    FROM gl_journal_document_links
    WHERE company_id = ${companyId}::UUID AND journal_entry_id = ${journalEntryId}::UUID AND unlinked_at IS NULL
    ORDER BY linked_at DESC
  `) as DbRow[];
  return rows.map(mapLink);
}

/**
 * Unlink — the journal's classification (reports/vatInputSupport.ts) reads
 * only the ACTIVE link, so after this the journal falls through to whatever
 * else supports it. Breaker fix (Hein, 2026-09-26, round 2): this UNLINK ROW
 * ITSELF (kept, `unlinked_at` set — never deleted) is what makes
 * `hadDocumentLink` true afterwards, so a journal with no other support
 * BLOCKS again as `document_unlinked` (`unsupportedInputVat`) — not the
 * warning `no_document`, which is reserved for a journal that never had a
 * document link at all. It clears only by linking a document again (the
 * normal document checks then apply) or another support existing (bank /
 * credit note / VAT adjustment), or by an owner/admin override. Refuses a
 * link that is not active or not in this company.
 */
export async function unlinkDocumentFromJournal(
  companyId: string,
  journalEntryId: string,
  capturedDocumentId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const why = reason.trim();
  if (!why) throw new JournalDocumentLinkRefusal('A reason is required to unlink a document from a journal.');

  const rows = (await sql`
    UPDATE gl_journal_document_links
    SET unlinked_at = now(), unlinked_by = ${userId}, unlink_reason = ${why}
    WHERE company_id = ${companyId}::UUID AND journal_entry_id = ${journalEntryId}::UUID
      AND captured_document_id = ${capturedDocumentId}::UUID AND unlinked_at IS NULL
    RETURNING id
  `) as DbRow[];
  if (!rows[0]) throw new JournalDocumentLinkRefusal('No active link found for that journal and document.');

  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'gl_journal_entry', entityId: journalEntryId,
    changes: {
      fields: [{ field: 'linked_document', old: capturedDocumentId, new: null, label: 'Tax invoice unlinked' }],
      metadata: { reason: why, capturedDocumentId },
    },
  });
  log.info('Document unlinked from journal', { companyId, journalEntryId, capturedDocumentId }, 'journalDocumentLinkService');
}

export interface LinkableDocument {
  id: string;
  fileName: string;
  documentType: string | null;
  createdAt: string;
}

/**
 * Captured documents of the company, newest first, not currently backing
 * another claim (source_document_id OR active link) and not still being
 * read in the background (its extraction is not there yet), for the "pick a
 * document" UI. `q` filters on file name, case-insensitive substring.
 */
export async function listLinkableDocuments(
  companyId: string, q?: string, limit = 25,
): Promise<LinkableDocument[]> {
  const pattern = q && q.trim() ? `%${q.trim()}%` : null;
  const rows = (await sql`
    SELECT cd.id, cd.file_name, cd.document_type, cd.created_at
    FROM captured_documents cd
    WHERE cd.company_id = ${companyId}::UUID
      AND (${pattern}::TEXT IS NULL OR cd.file_name ILIKE ${pattern})
      AND NOT (cd.read_state = 'reading'
        AND COALESCE(cd.read_heartbeat_at, cd.created_at) > NOW() - make_interval(mins => ${STALE_AFTER_MINUTES}))
      AND NOT EXISTS (
        SELECT 1 FROM gl_journal_entries je
        WHERE je.company_id = ${companyId}::UUID AND je.source_document_id = cd.id
          AND je.status = 'posted' AND ${journalStandsFragment('je.id', companyId)}
      )
      AND NOT EXISTS (
        SELECT 1 FROM gl_journal_document_links jdl
        WHERE jdl.company_id = ${companyId}::UUID AND jdl.captured_document_id = cd.id
          AND jdl.unlinked_at IS NULL
      )
    ORDER BY cd.created_at DESC
    LIMIT ${limit}
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id),
    fileName: String(r.file_name ?? ''),
    documentType: r.document_type == null ? null : String(r.document_type),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}
