/**
 * WHICH CAUGHT ERRORS ARE "THE READ FAILED", for the few pack reads whose
 * failure the pack is allowed to print as an absence.
 *
 * Three places degrade rather than fail — the comparative and budget columns
 * (`packFigureSet`), page 11's four sources (`packMatters`) and the
 * receivables decomposition (`boardPackDocument`). Each caught EVERYTHING, so
 * a `TypeError` from a defect in this codebase became "no comparative" or "the
 * check could not be assessed" on a document a director reads, and nothing
 * went red. Only the database refusing the read is the failure those catches
 * were written for; anything else is re-thrown by the caller.
 *
 * EVERY SUCH READ ALSO RUNS IN ITS OWN SAVEPOINT (`withSavepoint`). Under
 * `withAuth` the request is one transaction on one connection: a statement
 * that fails aborts it, and catching the error in application code does not
 * un-abort it — the next query is refused with 25P02 whatever it asks. The
 * savepoints are taken one at a time, never inside a `Promise.all`: on one
 * connection they nest LIFO.
 */

/** A statement refused because the transaction was ALREADY aborted. Not this
 *  read failing — an earlier one did, and nothing since can be trusted. */
const IN_FAILED_TRANSACTION = '25P02';

/** The SQLSTATE node-postgres puts on a server error, or null. */
function sqlStateOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** Whether the database refused this read — the one failure a degrading read
 *  may answer with an absence. */
export function isFailedRead(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state !== null && state !== IN_FAILED_TRANSACTION;
}
