/**
 * WHICH CAUGHT ERRORS ARE "THE READ FAILED", for the few pack reads whose
 * failure the pack is allowed to print as an absence.
 *
 * Three places degrade rather than fail — the comparative and budget columns
 * (`packFigureSet`), page 11's four sources (`packMatters`) and the
 * receivables decomposition (`boardPackDocument`). Each caught EVERYTHING, so
 * a `TypeError` from a defect in this codebase became "no comparative" or "the
 * check could not be assessed" on a document a director reads, and nothing
 * went red. Only the database being unable to serve the read is the failure
 * those catches were written for; anything else is re-thrown by the caller.
 *
 * EVERY SUCH READ ALSO RUNS IN ITS OWN SAVEPOINT (`withSavepoint`). Under
 * `withAuth` the request is one transaction on one connection: a statement
 * that fails aborts it, and catching the error in application code does not
 * un-abort it — the next query is refused with 25P02 whatever it asks. The
 * savepoints are taken one at a time, never inside a `Promise.all`: on one
 * connection they nest LIFO.
 */

/**
 * THE SQLSTATE CLASSES THAT ARE THE DATABASE BEING UNAVAILABLE, not this code
 * or this schema being wrong. An allowlist, because the alternative was tried:
 * "any SQLSTATE but 25P02" let an undefined table (42P01), an undefined column
 * (42703), a bad cast (22xxx) and a constraint violation (23xxx) print as an
 * absent comparative behind one warn.
 *
 *   08  connection exception
 *   40  transaction rollback — deadlock, serialization failure
 *   53  insufficient resources — disk, memory, connections
 *   55  object not in prerequisite state — lock not available, object in use
 *   57  operator intervention — statement timeout (57014), shutdown
 *   58  system error
 *
 * Everything else is re-thrown by the caller: class 42, 22, 23, XX, 25
 * (25P02 is an EARLIER read having failed, not this one), any class not
 * listed, and any `code` that is not a SQLSTATE at all.
 */
const OPERATIONAL_CLASSES: ReadonlySet<string> = new Set(['08', '40', '53', '55', '57', '58']);

/**
 * A `code` shaped like a SQLSTATE, or null. Shape only: Node's own `EPIPE` is
 * five capitals too, and it is the allowlist above that turns it away — `EP`
 * is not a class anybody may degrade on.
 */
function sqlStateOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * What a swallowed read failure may say in a log line: the error's class and
 * its SQLSTATE. Never `String(error)` or its message — a driver's message
 * carries whatever the server put in it, SQL text and row values included,
 * into a line that outlives the request.
 */
export function failedReadLabel(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const state = sqlStateOf(error);
  return state === null ? error.name : `${error.name} (SQLSTATE ${state})`;
}

/** Whether the database could not serve this read — the one failure a
 *  degrading read may answer with an absence. */
export function isFailedRead(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state !== null && OPERATIONAL_CLASSES.has(state.slice(0, 2));
}
