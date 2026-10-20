/**
 * Timing shared by the Netcash sender and the code that must not act while a send may still be running (AP-01).
 * Its own module so tests that replace netcashService do not lose the constants.
 */

/** A request to Netcash is aborted after this long (netcashService.fetchWithTimeout). */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A claim is 'pending' from its commit until the settle, which is the send (at most REQUEST_TIMEOUT_MS) plus the
 * settle's pool checkout (15 s) and a margin for a slow database or a paused process. Younger than this, a pending
 * claim is a send in flight and nothing may release it; older, its process is presumed dead (resolve).
 */
export const SEND_WINDOW_MS = REQUEST_TIMEOUT_MS + 90_000;
