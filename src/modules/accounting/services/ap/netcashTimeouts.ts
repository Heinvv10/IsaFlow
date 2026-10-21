/**
 * Timing shared by the Netcash sender and the code that must not act while a send may still be running (AP-01).
 * Its own module so tests that replace netcashService do not lose the constants.
 */

/** A request to Netcash is aborted after this long (netcashService.fetchWithTimeout). */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A claim is 'pending' from its commit until the settle, which is the send (at most REQUEST_TIMEOUT_MS) plus a margin
 * for a slow database or a paused process (the settle reuses the claim's connection: no pool checkout). Younger than
 * this, a pending claim may be a send in flight whose send lock went with a dead connection, and nothing may release
 * it; older, with no send lock held, its sender is presumed gone (resolve).
 */
export const SEND_WINDOW_MS = REQUEST_TIMEOUT_MS + 90_000;

/**
 * How long a submit waits for the claim's pooled connection (AP-01 round 11). Past it the submit is refused 503 with
 * nothing claimed or sent: a pool busy enough to make a send wait is not one to hold a connection in for 30 s more.
 */
export const CLAIM_CONNECTION_TIMEOUT_MS = 2_000;

/**
 * Bounds on the settle - recording Netcash's answer - on the claim connection and on the retry (AP-01 round 12). A
 * settle that stalls (a row held by someone else, a connection that stopped answering) would otherwise hold its send
 * slot for good. lock_timeout and statement_timeout are tightened in the settle transaction (never loosened); the
 * client gives up after SETTLE_QUERY_TIMEOUT_MS, ABOVE the statement bound so the server always stops first when it
 * can still hear us.
 */
export const SETTLE_LOCK_TIMEOUT_MS = 2_000;
export const SETTLE_STATEMENT_TIMEOUT_MS = 4_000;
export const SETTLE_QUERY_TIMEOUT_MS = SETTLE_STATEMENT_TIMEOUT_MS + 2_000;
