/**
 * Row locks for the capture WRITE paths.
 *
 * Both posting routes read a status, refuse on the settled value, and stamp the
 * settled value only at the very end of the request. That is a check-then-act
 * window: two concurrent requests — the UI double-click the guard was added for,
 * or a client retry — both read 'pending', both pass, and both create and
 * auto-post a journal against the same source document. Nothing downstream
 * catches it, because `idx_gl_je_source_document`
 * (409_capture_and_evidence_ledger.sql:91) is a plain index, not a unique one.
 *
 * `FOR UPDATE` taken here is held for the rest of the request: since PR #264
 * every request runs in one transaction on the AsyncLocalStorage-bound client,
 * so the second request blocks on the row, then re-reads the settled status and
 * refuses. Same shape and the same reasoning as `bankTxLock.ts`, including why
 * `SET LOCAL lock_timeout` is re-issued on every call rather than memoised.
 *
 * A LOCK IS NOT THE WHOLE ANSWER, and reading it as one is what left the
 * routes open in sequence: they guarded on DIFFERENT rows, so an operator
 * posting a receipt and then opening the same document in the capture inbox got
 * two VAT-bearing journals against one receipt with no concurrency in it. The
 * DOCUMENT is the thing that can only be posted once, so every posting route
 * locks it, reads it, and CLAIMS it before its first write.
 *
 * Lock order is document-then-event on every path, so there is no cycle to
 * deadlock on: nothing takes them the other way round.
 *
 * THE FENCE IS `captured_documents.posted_at`, NOT `status`. It was `status`,
 * and every leak this module has had came from that: `status` is a lifecycle
 * column four subsystems write for four reasons ('reviewed' from the confirm
 * button, 'rejected' from reject, 'matched' from attaching the slip to a bank
 * transaction, 'matched' again from a posting route). As a posting fence it
 * failed in both directions at once — confirm RESET it and a second post went
 * through, 'rejected' was ADMITTED by a `<> 'matched'` predicate, and a
 * document merely attached to a bank transaction was REFUSED with "already
 * posted to a journal" when no journal existed. `posted_at` means one thing,
 * is written by a posting path and nothing else, and is claimed with
 * `WHERE posted_at IS NULL` (migration 672).
 *
 * Behind it, `uq_gl_je_capture_source_document` (same migration) is a partial
 * UNIQUE index on `gl_journal_entries(company_id, source_document_id)` for
 * `source = 'auto_expense_receipt'` and unreversed rows only, so a JOURNAL route
 * that forgets to claim — or one invented later — still cannot land a second
 * live posting journal against one receipt.
 *
 * IT REACHES TWO OF THE FOUR ROUTES, and saying otherwise is how the fourth got
 * built without a claim. `capture/[id]/post` and `ai-invoice-pipeline` write
 * `supplier_invoices`, a different table the index does not touch; the claim is
 * the whole fence there. `fix.md` tables every writer and what covers it.
 *
 * `releaseCapturedDocumentPostingClaim` is the way back: reversing the journal
 * or cancelling the invoice clears `posted_at`, which is what makes the refusal
 * message's "Reverse the journal or invoice first" a true instruction rather
 * than a dead end.
 *
 * Write paths ONLY.
 */

import { als, assertTxUsable } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** `lock_not_available` (the 5s `lock_timeout` elapsed) and `deadlock_detected`. */
const RETRYABLE_LOCK_ERRORS = new Set(['55P03', '40P01']);

/**
 * Raised when another request holds the row past the 5s `lock_timeout`, or the
 * wait deadlocked. The capture inbox routes answer it 409 (R-058), the others
 * 400; either way the wording is what the operator reads — it says "retry".
 */
export class CaptureRowLockTimeoutError extends Error {
  readonly code = 'CAPTURE_ROW_LOCK_TIMEOUT';
  constructor(rowId: string) {
    super(`Capture record ${rowId} is being posted by another request — retry in a moment.`);
    this.name = 'CaptureRowLockTimeoutError';
  }
}

function isRetryableLockError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null
    ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && RETRYABLE_LOCK_ERRORS.has(code);
}

/**
 * One `FOR UPDATE` read under a bounded wait, the bound RESET once granted —
 * else it bounds every later lock wait in the request and a downstream 55P03
 * escapes as a 500 (R-058, `captureEventLock.ts`). Not reset after a failure:
 * the tx is aborted, and another statement would mask the error with 25P02.
 */
async function lockWithTimeout(rowId: string, read: () => Promise<DbRow[]>): Promise<DbRow | null> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      `Locking capture row ${rowId} requires a request transaction (withAuth / als.run). `
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = await read();
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return rows[0] ?? null;
  } catch (err) {
    if (isRetryableLockError(err)) throw new CaptureRowLockTimeoutError(rowId);
    throw err;
  }
}

/**
 * Hold the captured document for the rest of the request.
 *
 * Returns null when the row does not exist or belongs to another tenant, so
 * callers keep their own NOT_FOUND wording.
 */
export async function lockCapturedDocumentForUpdate(
  companyId: string,
  documentId: string,
): Promise<DbRow | null> {
  return lockWithTimeout(documentId, async () => (await sql`
    SELECT extracted_data, status, posted_at FROM captured_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}
    FOR UPDATE`) as DbRow[]);
}

/**
 * Hold the capture event for the rest of the request.
 *
 * Taken AFTER `lockCapturedDocumentForUpdate` on the route that needs both, so
 * the two rows are always acquired in the same order. The event lock is what
 * serialises two posts of the SAME event; the document lock above is what
 * serialises two posts of the same receipt through different routes.
 */
export async function lockCaptureEventForUpdate(
  companyId: string,
  eventId: string,
): Promise<DbRow | null> {
  return lockWithTimeout(eventId, async () => (await sql`
    SELECT id FROM capture_events
    WHERE id = ${eventId}::uuid AND company_id = ${companyId}
    FOR UPDATE`) as DbRow[]);
}

/**
 * Why a posting route refused the document.
 *
 * Two reasons, two messages: telling an operator "already posted to a journal"
 * about a document that was merely rejected — or merely attached to a bank
 * transaction — is a false statement about the ledger, and the only undo the
 * product offered for it was the confirm button, which is itself a bypass.
 */
export type CapturedDocumentRefusal = 'already_posted' | 'rejected';

export const CAPTURED_DOCUMENT_REFUSAL_MESSAGE: Record<CapturedDocumentRefusal, string> = {
  already_posted: 'Document already posted',
  rejected: 'Document was rejected — reopen it before posting',
};

/**
 * The refusal a locked document row earns, or null when it may be posted.
 *
 * `posted_at` is the fence; `status` is consulted for one value only, the
 * terminal `'rejected'` an operator set deliberately. Every other status —
 * including the `'matched'` that attaching the slip to a bank transaction
 * writes — is postable, which is the whole point of moving off the column.
 */
export function refusalForPosting(
  row: { status?: unknown; posted_at?: unknown },
): CapturedDocumentRefusal | null {
  if (row.posted_at != null) return 'already_posted';
  if (row.status === 'rejected') return 'rejected';
  return null;
}

/**
 * The document cannot be posted: already claimed by another route or request,
 * or rejected by an operator.
 *
 * Thrown rather than returned where the claim happens inside a service, so the
 * route can answer 400 with the same wording it uses for its own read guard.
 * Safe to answer 4xx with, and only because of WHERE it is thrown: the claim is
 * every caller's LAST read-only step, so a refusal has written nothing and
 * `withAuth`'s commit-on-4xx commits nothing.
 */
export class CapturedDocumentAlreadyPostedError extends Error {
  readonly code = 'CAPTURED_DOCUMENT_ALREADY_POSTED';
  readonly refusal: CapturedDocumentRefusal;
  constructor(refusal: CapturedDocumentRefusal = 'already_posted') {
    super(CAPTURED_DOCUMENT_REFUSAL_MESSAGE[refusal]);
    this.name = 'CapturedDocumentAlreadyPostedError';
    this.refusal = refusal;
  }
}

/**
 * Claim the document for posting: stamp `posted_at`, but only from a row that
 * has not been claimed and has not been rejected.
 *
 * The read under `lockCapturedDocumentForUpdate` refuses the ordinary second
 * attempt with an accurate message. This is the fence behind it — one statement
 * carrying the same predicate the read did, so a caller reaching the write
 * without the lock still cannot post what another path settled. The predicate
 * is on `posted_at`: a status-predicated claim is only as durable as the
 * lifecycle column it rides on, and that column is rewritten by the confirm
 * button, the reject button and the bank-attach path — none of which know they
 * are unlocking a ledger write.
 *
 * Callers MUST run it BEFORE their first ledger write and answer a refusal with
 * a 4xx. That ordering is the safe one: `withAuth` COMMITs the request
 * transaction on a 4xx, so a refusal here commits nothing (the UPDATE matched
 * no row), while every failure AFTER it throws and rolls the claim back with
 * the journal.
 *
 * `status = 'matched'` is stamped alongside because the inbox reads that column
 * to show the document as settled; it is now a consequence of posting, never
 * the thing that decides it. `document_category` is stamped for the two routes
 * that set it; passing null leaves the column untouched.
 *
 * Returns null when the claim succeeded, otherwise the reason it did not.
 */
export async function claimCapturedDocumentForPosting(
  companyId: string,
  documentId: string,
  documentCategory: string | null = null,
): Promise<CapturedDocumentRefusal | null> {
  const rows = (await sql`
    UPDATE captured_documents
       SET posted_at = NOW(),
           status = 'matched',
           document_category = COALESCE(${documentCategory}, document_category),
           updated_at = NOW()
     WHERE id = ${documentId}::uuid
       AND company_id = ${companyId}
       AND posted_at IS NULL
       AND status <> 'rejected'
    RETURNING id`) as DbRow[];
  if (rows.length === 1) return null;

  // Which of the two predicates refused it. The row is held under
  // `lockCapturedDocumentForUpdate` on every posting path, so this re-read sees
  // the settled values. A row that vanished (wrong tenant, deleted) reports
  // 'already_posted' — the caller has already answered NOT_FOUND for that case
  // from its own earlier read.
  const [row] = (await sql`
    SELECT status, posted_at FROM captured_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}`) as DbRow[];
  return row ? (refusalForPosting(row) ?? 'already_posted') : 'already_posted';
}

/** The two rows a capture-inbox post has to agree on, read under both locks. */
export interface CaptureEventForPosting {
  eventStatus: string;
  documentId: string;
  documentStatus: string;
  documentPostedAt: Date | string | null;
  extractedData: unknown;
}

/**
 * Resolve the document behind a capture event, lock BOTH rows in the module's
 * order, and re-read the settled statuses.
 *
 * The document id has to be read before either lock can be taken, which is why
 * this is three statements rather than one: the pre-lock SELECT finds the row
 * to lock, and the post-lock SELECT is the one whose answers are trustworthy.
 *
 * Returns null when the event does not exist or belongs to another tenant, so
 * the caller keeps its own NOT_FOUND wording.
 */
export async function lockCaptureEventForPosting(
  companyId: string,
  eventId: string,
): Promise<CaptureEventForPosting | null> {
  const [idRow] = (await sql`
    SELECT captured_document_id FROM capture_events
    WHERE id = ${eventId}::uuid AND company_id = ${companyId}
    LIMIT 1`) as DbRow[];
  const documentId = idRow?.captured_document_id as string | undefined;
  if (!documentId) return null;

  await lockCapturedDocumentForUpdate(companyId, documentId);
  await lockCaptureEventForUpdate(companyId, eventId);

  const [row] = (await sql`
    SELECT ce.status AS event_status, ce.captured_document_id,
           cd.status AS document_status, cd.posted_at AS document_posted_at,
           cd.extracted_data
    FROM capture_events ce
    JOIN captured_documents cd ON cd.id = ce.captured_document_id
    WHERE ce.id = ${eventId}::uuid
      AND ce.company_id = ${companyId}
      AND cd.company_id = ${companyId}
    LIMIT 1`) as DbRow[];
  if (!row) return null;

  return {
    eventStatus: String(row.event_status),
    documentId: String(row.captured_document_id),
    documentStatus: String(row.document_status),
    documentPostedAt: (row.document_posted_at as Date | string | null) ?? null,
    extractedData: row.extracted_data,
  };
}
