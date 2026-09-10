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
 * A LOCK IS NOT THE WHOLE ANSWER, and reading it as one is what left the two
 * routes open in sequence. They guarded on DIFFERENT rows: `receipt-to-journal`
 * on `captured_documents.status`, `post-expense` on `capture_events.status`,
 * with only the second stamping both. So `post-expense` → `receipt-to-journal`
 * was refused and `receipt-to-journal` → `post-expense` was not refused at all
 * — an operator posting a receipt and then opening the same document in the
 * capture inbox got two VAT-bearing journals against one receipt, with no
 * concurrency anywhere in it. The DOCUMENT is the thing that can only be posted
 * once, so every posting route now locks it, reads it, and CLAIMS it through
 * `claimCapturedDocumentForPosting` before its first write.
 *
 * Lock order is document-then-event on every path, so there is no cycle to
 * deadlock on: `receipt-to-journal` takes the document alone, `post-expense`
 * takes the document and then the event, and nothing takes them the other way
 * round. (An earlier version of this comment claimed the opposite; there was
 * never a path that took the event before the document.)
 *
 * Write paths ONLY.
 */

import { als, assertTxUsable } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds the row longer than the 5s `lock_timeout`.
 * Both routes answer a caught service error as a 400, so the wording is what
 * the operator reads — it has to say "retry".
 */
export class CaptureRowLockTimeoutError extends Error {
  readonly code = 'CAPTURE_ROW_LOCK_TIMEOUT';
  constructor(rowId: string) {
    super(`Capture record ${rowId} is being posted by another request — retry in a moment.`);
    this.name = 'CaptureRowLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

async function beginLock(rowId: string): Promise<void> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      `Locking capture row ${rowId} requires a request transaction (withAuth / als.run). `
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
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
  await beginLock(documentId);
  try {
    const rows = (await sql`
      SELECT extracted_data, status FROM captured_documents
      WHERE id = ${documentId}::uuid AND company_id = ${companyId}
      FOR UPDATE`) as DbRow[];
    return rows[0] ?? null;
  } catch (err) {
    if (isLockTimeout(err)) throw new CaptureRowLockTimeoutError(documentId);
    throw err;
  }
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
  await beginLock(eventId);
  try {
    const rows = (await sql`
      SELECT id FROM capture_events
      WHERE id = ${eventId}::uuid AND company_id = ${companyId}
      FOR UPDATE`) as DbRow[];
    return rows[0] ?? null;
  } catch (err) {
    if (isLockTimeout(err)) throw new CaptureRowLockTimeoutError(eventId);
    throw err;
  }
}

/**
 * The document has already been posted by another route or another request.
 *
 * Thrown rather than returned where the claim happens inside a service, so the
 * route can answer 400 with the same wording it uses for its own read guard.
 * Safe to answer 4xx with, and only because of WHERE it is thrown: the claim is
 * every caller's LAST read-only step, so a refusal has written nothing and
 * `withAuth`'s commit-on-4xx commits nothing.
 */
export class CapturedDocumentAlreadyPostedError extends Error {
  readonly code = 'CAPTURED_DOCUMENT_ALREADY_POSTED';
  constructor() {
    super('Document already posted to a journal');
    this.name = 'CapturedDocumentAlreadyPostedError';
  }
}

/**
 * Claim the document for posting: stamp it 'matched', but only from a status
 * that is not already settled.
 *
 * The status read under `lockCapturedDocumentForUpdate` is what refuses the
 * ordinary second attempt with a 400. This is the fence behind it — a single
 * statement whose WHERE clause carries the same predicate the read did, so that
 * a caller which somehow reaches the write without the lock (a future route, a
 * path that forgets it) still cannot post a document another path has settled.
 *
 * Callers MUST run it BEFORE their first ledger write and answer `false` with a
 * 4xx. That ordering is the safe one: `withAuth` COMMITs the request
 * transaction on a 4xx, so a refusal here commits nothing (the UPDATE matched
 * no row), while every failure AFTER it throws and rolls the claim back with
 * the journal.
 *
 * `document_category` is stamped alongside because the two routes that set it
 * did so in this same statement; passing null leaves the column untouched.
 */
export async function claimCapturedDocumentForPosting(
  companyId: string,
  documentId: string,
  documentCategory: string | null = null,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE captured_documents
       SET status = 'matched',
           document_category = COALESCE(${documentCategory}, document_category),
           updated_at = NOW()
     WHERE id = ${documentId}::uuid
       AND company_id = ${companyId}
       AND status <> 'matched'
    RETURNING id`) as DbRow[];
  return rows.length === 1;
}

/** The two rows a capture-inbox post has to agree on, read under both locks. */
export interface CaptureEventForPosting {
  eventStatus: string;
  documentId: string;
  documentStatus: string;
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
           cd.status AS document_status, cd.extracted_data
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
    extractedData: row.extracted_data,
  };
}
