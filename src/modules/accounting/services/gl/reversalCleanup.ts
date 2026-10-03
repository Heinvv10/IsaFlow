/**
 * A cleanup after a failed step of `reverseJournalEntry` (D8 round 16).
 *
 * The rule:
 *  · the cleanup meets an ABORTED transaction (25P02) — the failure was a Postgres error, such as a lock timeout on
 *    the posting trigger's gl_account_balances row under a flow budget — the ORIGINAL failure is re-thrown. The
 *    25P02 used to replace it, so a 503 became a 500; the rollback that must follow undoes what the cleanup would.
 *  · the cleanup fails any other way on a usable transaction — that is a new fault, and the claim or the draft it
 *    was undoing may still stand — the CLEANUP's error is thrown, so it is not hidden behind the step's.
 *  · the cleanup succeeds — its result is returned; the caller re-throws the original itself.
 */
export async function cleanUpAfter<T>(failure: unknown, cleanup: () => Promise<T>): Promise<T> {
  try {
    return await cleanup();
  } catch (cleanupErr) {
    if ((cleanupErr as { code?: unknown } | null)?.code === '25P02') throw failure;
    throw cleanupErr;
  }
}
