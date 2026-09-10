/**
 * Row-lock helper for the two capture POSTING routes.
 *
 * `capture/[id]/post.ts` and `capture/[id]/post-expense.ts` both read
 * `capture_events.status`, refuse in JavaScript when it is already `'posted'`,
 * and then create a supplier invoice / an expense claim / a GL journal — closing
 * with an `UPDATE ... SET status = 'posted'` that carries no status predicate.
 * Two concurrent requests (a UI double-click, an agent retry) both read
 * `'extracted'`, both pass the check and both post: one captured document, two
 * accruals.
 *
 * `FOR UPDATE OF ce` closes the window. Since every request runs in a single
 * transaction on the AsyncLocalStorage-bound client (PR #264), the lock taken
 * here is held for the rest of the request: the second request blocks on the
 * row, and when the first commits READ COMMITTED re-reads the row at its new
 * version — `status = 'posted'` — so the caller's existing refusal fires before
 * anything is written. That ordering matters because `withAuth` COMMITs any
 * response below 500: a refusal returned AFTER a write leaves the write behind.
 *
 * Only `ce` is locked. `captured_documents` is joined for `extracted_data` and
 * must not be locked here — the extraction pipeline writes that row.
 *
 * Write paths ONLY — the inbox list queries must never take this lock.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

/**
 * Postgres `lock_not_available` (the 5s `lock_timeout` elapsed) and
 * `deadlock_detected`. Both mean the same thing to the caller: another request
 * holds this capture event, try again.
 */
const RETRYABLE_LOCK_ERRORS = new Set(['55P03', '40P01']);

/**
 * Raised when another request holds the capture event longer than the 5s
 * `lock_timeout`. The capture routes answer this as a 409, so the wording is
 * what the operator reads — it has to say "retry".
 */
export class CaptureEventLockedError extends Error {
  readonly code = 'CAPTURE_EVENT_LOCKED';
  constructor(eventId: string) {
    super(`Capture event ${eventId} is being posted by another request — retry in a moment.`);
    this.name = 'CaptureEventLockedError';
  }
}

function isRetryableLockError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null
    ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && RETRYABLE_LOCK_ERRORS.has(code);
}

/**
 * Read one capture event with its captured document and hold a row lock on the
 * event until the end of the surrounding transaction. Returns `null` when the
 * event does not exist or belongs to another tenant — callers keep their own
 * NOT_FOUND wording.
 *
 * Throws if no request transaction is in flight: outside one every statement is
 * its own implicit transaction, so `FOR UPDATE` releases the instant the SELECT
 * returns and the caller believes it is serialised when it is not. A loud
 * failure beats a lock that silently does nothing.
 *
 * The 5s `lock_timeout` is re-issued on EVERY call rather than memoised per
 * request — `SET LOCAL` is subtransaction-aware, so a `ROLLBACK TO SAVEPOINT`
 * would restore `0` (wait forever) exactly on the contended paths. Same
 * reasoning as `bank/bankTxLock.ts`.
 */
export async function lockCaptureEventForPosting(
  companyId: string,
  eventId: string,
): Promise<DbRow | null> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'lockCaptureEventForPosting requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = (await sql`
      SELECT ce.id AS event_id, ce.status AS event_status,
             ce.captured_document_id, cd.extracted_data
      FROM capture_events ce
      JOIN captured_documents cd ON cd.id = ce.captured_document_id
      WHERE ce.id = ${eventId}::uuid
        AND ce.company_id = ${companyId}
        AND cd.company_id = ${companyId}
      LIMIT 1
      FOR UPDATE OF ce
    `) as DbRow[];
    return rows[0] ?? null;
  } catch (err) {
    if (isRetryableLockError(err)) throw new CaptureEventLockedError(eventId);
    throw err;
  }
}
