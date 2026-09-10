/**
 * Row-lock helpers and the postable-status vocabulary for the capture write
 * routes — `post.ts`, `post-expense.ts` and `discard.ts`.
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
 * `discard.ts` locks too (`lockCaptureEventRow`): it is the third writer of the
 * column the post guard reads, and its own unpredicated
 * `UPDATE ... SET status = 'discarded'` used to land AFTER a concurrent post
 * and leave a posted bill on an event the inbox showed as discarded.
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
 * The closed status vocabulary of `capture_events`, transcribed from the CHECK
 * constraint migration 409 created and no later migration has altered.
 */
const CAPTURE_EVENT_STATUSES = [
  'received', 'extracting', 'extracted', 'posted', 'discarded', 'failed',
] as const;

export type CaptureEventStatus = (typeof CAPTURE_EVENT_STATUSES)[number];

/**
 * The statuses a capture event may still be posted FROM.
 *
 * Expressed as an allow-list, not as a list of statuses to refuse. The guard's
 * question is "is this event still open for posting?", and the two routes used
 * to answer it by naming ONE value — `status === 'posted'` — which made every
 * other non-postable state postable. `'discarded'` was the live case: a user
 * discards a captured bill, the post route sees a status that is not
 * `'posted'`, and accrues it to payables anyway. No race needed.
 *
 * `'received'` / `'extracting'` stay postable because they always were. The
 * routes' `!extracted_data` refusal does NOT stop a still-extracting event —
 * `routeEvent` writes `captured_documents.extracted_data` in its own UPDATE
 * (`captureRouterService.ts` ~161) *before* it sets `capture_events.status =
 * 'extracted'` in a second, separate statement (~176), so a request that lands
 * between those two writes sees `status = 'extracting'` WITH data already
 * populated and both checks pass. What keeps that window survivable is that
 * `routeEvent` still runs to completion and flips the status forward — a
 * request racing it does not itself corrupt anything. Only an unpredicated
 * writer that could revert a `'posted'` event back to `'extracting'` would
 * turn this into a second post; that is R-071, tracked separately, not fixed
 * here. `'failed'` stays postable because it is a RETRY state, not a terminal
 * one — `post.ts` itself parks a duplicate there, and `routeEvent` parks an
 * extraction error there.
 *
 * Anything outside the vocabulary fails CLOSED: a status added to the CHECK
 * constraint tomorrow is not postable until someone decides here that it is.
 */
const POSTABLE_CAPTURE_EVENT_STATUSES: ReadonlySet<string> = new Set<CaptureEventStatus>([
  'received', 'extracting', 'extracted', 'failed',
]);

/** Terminal for posting: the work is either done or abandoned. */
export function isCaptureEventPostable(status: unknown): boolean {
  return typeof status === 'string' && POSTABLE_CAPTURE_EVENT_STATUSES.has(status);
}

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
  return lockWithTimeout(eventId, async () => (await sql`
    SELECT ce.id AS event_id, ce.status AS event_status,
           ce.captured_document_id, cd.extracted_data
    FROM capture_events ce
    JOIN captured_documents cd ON cd.id = ce.captured_document_id
    WHERE ce.id = ${eventId}::uuid
      AND ce.company_id = ${companyId}
      AND cd.company_id = ${companyId}
    LIMIT 1
    FOR UPDATE OF ce
  `) as DbRow[]);
}

/**
 * Lock ONE capture event row, with no join to `captured_documents`.
 *
 * `discard.ts` needs the same serialisation as the post routes — it is the
 * third writer of the column the post guard reads — but it must not inherit
 * the posting read's INNER JOIN: `capture_events.captured_document_id` is
 * nullable, so an event that never produced a document would stop being
 * discardable, which is a guard failing in the other direction.
 */
export async function lockCaptureEventRow(
  companyId: string,
  eventId: string,
): Promise<DbRow | null> {
  return lockWithTimeout(eventId, async () => (await sql`
    SELECT id, status
    FROM capture_events
    WHERE id = ${eventId}::uuid
      AND company_id = ${companyId}
    LIMIT 1
    FOR UPDATE
  `) as DbRow[]);
}

/**
 * Run one `FOR UPDATE` read under a bounded lock wait.
 *
 * The 5s `lock_timeout` is RESET the moment the lock is granted. `SET LOCAL`
 * otherwise bounds every lock wait for the REST of the transaction, so a
 * downstream 55P03 — JE numbering, `gl_account_balances`, a relation lock
 * during DDL — escaped as an opaque 500 while the identical contention one
 * statement earlier answered 409. Resetting keeps ONE contract on this path:
 * lock contention on the capture event is a 409 (`apiResponse.conflict`, the
 * convention `bank/bankTxLock.ts` and the bank routes already use on this
 * codebase — NOT `apiDocumentLock`'s 503 + `Retry-After`, which the capture
 * routes have never spoken), and everything downstream behaves exactly as it
 * did before this lock existed.
 *
 * The reset runs only after a GRANTED lock. A 55P03 aborts the transaction, so
 * issuing any further statement in a `finally` would raise 25P02 and mask the
 * real error.
 */
async function lockWithTimeout(
  eventId: string,
  read: () => Promise<DbRow[]>,
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
    const rows = await read();
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return rows[0] ?? null;
  } catch (err) {
    if (isRetryableLockError(err)) throw new CaptureEventLockedError(eventId);
    throw err;
  }
}
