/**
 * Bound the wait on a status-predicated CLAIMING UPDATE.
 *
 * The claim is deliberately taken BEFORE the document-number counter row, so
 * that a loser burns no number. That ordering moved the first blocking point a
 * concurrent caller hits onto the claim itself — and the claim had no
 * `lock_timeout`, while the counter row (the thing it was placed in front of)
 * does. A winner whose request stalled mid-transaction therefore parked every
 * other caller on that document indefinitely: exactly the symptom the counter
 * row's 5s ceiling exists to prevent, reintroduced one statement earlier.
 *
 * Narrower than the counter row — one document rather than the whole company's
 * numbering — but the same failure, so the same 5s and the same typed error.
 */

import { als, assertTxUsable } from '@/lib/als';
import { currentLockTimeout, restoreLockTimeout } from './rowLockBudget';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds the document being claimed longer than the
 * 5s `lock_timeout`. The transaction is ABORTED when this is raised, so a route
 * must answer it at or above 500 (see apiDocumentLock) — `withAuth` COMMITs
 * anything below.
 */
export class DocumentClaimLockTimeoutError extends Error {
  readonly code = 'DOCUMENT_CLAIM_LOCK_TIMEOUT';
  constructor(public readonly documentKind: string) {
    super(`This ${documentKind} is being converted by another request — retry in a moment.`);
    this.name = 'DocumentClaimLockTimeoutError';
  }
}

/**
 * Raised when a claim is attempted outside a request transaction, where it
 * would AUTOCOMMIT. The caller then posts a journal it can no longer roll back
 * with the claim, so a failure one statement later leaves the document claimed
 * — 'processed', 'approved' — with no journal behind it and no way through the
 * UI to retry, because every path that could retry is the one the claim now
 * refuses. The 5s ceiling would be fiction there too: `SET LOCAL` outside a
 * transaction affects nothing.
 */
export class ClaimOutsideTransactionError extends Error {
  readonly code = 'CLAIM_OUTSIDE_TRANSACTION';
  constructor(documentKind: string) {
    super(
      `Claiming this ${documentKind} requires a request transaction (withAuth / als.run). `
      + 'Outside one the claim autocommits and cannot be rolled back with the posting that follows it.',
    );
    this.name = 'ClaimOutsideTransactionError';
  }
}

/**
 * Run a claiming UPDATE under a 5s `lock_timeout`, inside the request
 * transaction. Throws `ClaimOutsideTransactionError` without one — same
 * reasoning as `lockTimeEntries`, which refuses rather than locking nothing.
 */
export async function claimUnderLockTimeout<T>(
  documentKind: string,
  claim: () => Promise<T>,
): Promise<T> {
  const client = als.getStore()?.client;
  if (!client) throw new ClaimOutsideTransactionError(documentKind);
  // Re-issued every call, never memoised: SET LOCAL is subtransaction-aware and
  // a savepoint rollback restores it to 0 — no timeout at all.
  assertTxUsable();
  const previousLockTimeout = await currentLockTimeout(client);
  await client.query("SET LOCAL lock_timeout = '5s'");
  let failure: unknown = null;
  try {
    const result = await claim();
    return result;
  } catch (err) {
    failure = err;
    if (typeof err === 'object' && err !== null
      && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new DocumentClaimLockTimeoutError(documentKind);
    }
    // Any OTHER failure out of the claim: the `finally` puts the caller's value back when `claim` failed as a JS
    // throw on a still-usable transaction; after a SQL failure (23505, 23514, 22P02 …) the transaction is aborted
    // like a 55P03 and the restore is skipped, so 'current transaction is aborted' never replaces `err`.
    throw err;
  } finally {
    await restoreLockTimeout(client, previousLockTimeout, failure);
  }
}
