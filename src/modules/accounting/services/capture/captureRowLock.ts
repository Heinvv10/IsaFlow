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
 * The event, not the document it joins to: the post-expense route's guard reads
 * `capture_events.status`, and locking the document as well would take the two
 * rows in the opposite order to the route above — a deadlock rather than a fix.
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
