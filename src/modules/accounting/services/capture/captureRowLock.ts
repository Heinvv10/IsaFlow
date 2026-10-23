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
import { isCaptureEventPostable } from './captureEventLock';
import { currentLockTimeout, restoreLockTimeout } from '../core/rowLockBudget';

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
export async function lockWithTimeout(rowId: string, read: () => Promise<DbRow[]>): Promise<DbRow | null> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      `Locking capture row ${rowId} requires a request transaction (withAuth / als.run). `
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  assertTxUsable();
  const previousLockTimeout = await currentLockTimeout(client);
  await client.query("SET LOCAL lock_timeout = '5s'");
  let failure: unknown = null;
  try {
    const rows = await read();
    return rows[0] ?? null;
  } catch (err) {
    failure = err;
    if (isRetryableLockError(err)) throw new CaptureRowLockTimeoutError(rowId);
    throw err;
  } finally {
    await restoreLockTimeout(client, previousLockTimeout, failure);
  }
}

/**
 * Hold the captured document for the rest of the request.
 *
 * Returns null when the row does not exist or belongs to another tenant, so
 * callers keep their own NOT_FOUND wording. The read columns come back too, for `isBeingRead`.
 */
export async function lockCapturedDocumentForUpdate(
  companyId: string,
  documentId: string,
): Promise<DbRow | null> {
  return lockWithTimeout(documentId, async () => (await sql`
    SELECT extracted_data, vendor_name, status, posted_at, read_state, read_heartbeat_at, created_at
    FROM captured_documents
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
 * Lock every capture_events row tied to a document — for `ai-invoice-pipeline`,
 * the one posting route that reaches a document directly and carries no event
 * id of its own; every other poster gets its event id from the URL and locks
 * it through `lockCaptureEventForUpdate` / `lockCaptureEventForPosting`.
 *
 * Locked here, alongside the document (document-then-event, the module's own
 * order), BEFORE the first ledger write — so the `status = 'posted'` update a
 * successful pipeline run issues at the very end (R-169), mirroring what
 * `capturePostFollowUps` does for the one event id it already knows, never
 * waits on a NEW lock: this transaction already holds the row, and a
 * concurrent `discard` blocks behind it instead of racing it.
 *
 * Returns only the ids still open for posting (`isCaptureEventPostable`). A document with no capture_events
 * row (an upload straight through `/accounting/capture`) returns [], and the caller's later UPDATE is a no-op.
 */
export async function lockPostableCaptureEventIds(
  companyId: string,
  documentId: string,
): Promise<string[]> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      `Locking capture events for document ${documentId} requires a request transaction (withAuth / als.run). `
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  assertTxUsable();
  const previousLockTimeout = await currentLockTimeout(client);
  await client.query("SET LOCAL lock_timeout = '5s'");
  let rows: DbRow[];
  let failure: unknown = null;
  try {
    rows = (await sql`
      SELECT id, status FROM capture_events
      WHERE captured_document_id = ${documentId}::uuid AND company_id = ${companyId}
      FOR UPDATE`) as DbRow[];
  } catch (err) {
    failure = err;
    if (isRetryableLockError(err)) throw new CaptureRowLockTimeoutError(documentId);
    throw err;
  } finally {
    await restoreLockTimeout(client, previousLockTimeout, failure);
  }
  return rows.filter((row) => isCaptureEventPostable(row.status)).map((row) => String(row.id));
}

/** Stamp every given capture_events id posted — `ai-invoice-pipeline`'s counterpart to what
 * `capturePostFollowUps` does for its one event id. No-op when `eventIds` is empty. */
export async function markCaptureEventsPosted(
  companyId: string,
  eventIds: string[],
  postedBy: string,
): Promise<void> {
  if (eventIds.length === 0) return;
  await sql`
    UPDATE capture_events
    SET status = 'posted', posted_by = ${postedBy}, posted_at = NOW(), updated_at = NOW()
    WHERE id = ANY(${eventIds}::uuid[]) AND company_id = ${companyId}
  `;
}

/** Stamp every given capture_events id 'failed'/'duplicate' — the same shape `capture/[id]/post`
 * stamps on `duplicate_blocked` (R-169 r2). No-op when `eventIds` is empty. */
export async function markCaptureEventsDuplicate(
  companyId: string,
  eventIds: string[],
): Promise<void> {
  if (eventIds.length === 0) return;
  await sql`
    UPDATE capture_events
    SET status = 'failed', error = 'duplicate', updated_at = NOW()
    WHERE id = ANY(${eventIds}::uuid[]) AND company_id = ${companyId}
  `;
}

// The claim itself lives in `capturePostingClaim.ts`; re-exported so every
// posting route keeps importing the lock and the claim from one module.
export {
  CAPTURED_DOCUMENT_REFUSAL_ERROR_CODE,
  CAPTURED_DOCUMENT_REFUSAL_MESSAGE,
  CapturedDocumentAlreadyPostedError,
  claimCapturedDocumentForPosting,
  refusalForPosting,
  type CapturedDocumentRefusal,
  type ClaimContent,
  type PostedReceiptFingerprint,
} from './capturePostingClaim';

/** The two rows a capture-inbox post has to agree on, read under both locks. */
export interface CaptureEventForPosting {
  eventStatus: string;
  documentId: string;
  documentStatus: string;
  documentPostedAt: Date | string | null;
  extractedData: unknown;
  /** A person's correction of the vendor (`captured_documents.vendor_name`), which the meals hold reads first (K-072 r37). */
  documentVendorName: string | null;
  /** The event's own expense account, first in R-131's fallback for a bill with no extracted lines. */
  resolvedGlAccountId: string | null;
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
           cd.extracted_data, cd.vendor_name, ce.resolved_gl_account_id
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
    documentVendorName: (row.vendor_name as string | null) ?? null,
    resolvedGlAccountId: (row.resolved_gl_account_id as string | null) ?? null,
  };
}
