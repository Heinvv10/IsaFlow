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
