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
 * Run a claiming UPDATE under a 5s `lock_timeout`.
 *
 * Outside a request transaction the ceiling is skipped rather than faked:
 * `SET LOCAL` affects nothing there, and a claim outside a transaction is a
 * single implicit-transaction statement that cannot park on anything for long.
 */
export async function claimUnderLockTimeout<T>(
  documentKind: string,
  claim: () => Promise<T>,
): Promise<T> {
  const client = als.getStore()?.client;
  if (!client) return claim();
  // Re-issued every call, never memoised: SET LOCAL is subtransaction-aware and
  // a savepoint rollback restores it to 0 — no timeout at all.
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const result = await claim();
    // Restored on the SUCCESS path only. After a timeout the transaction is
    // aborted and this statement would itself raise 25P02, replacing the typed
    // error with an opaque one.
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return result;
  } catch (err) {
    if (typeof err === 'object' && err !== null
      && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new DocumentClaimLockTimeoutError(documentKind);
    }
    throw err;
  }
}
