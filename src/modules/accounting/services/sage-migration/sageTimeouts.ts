/** The migration's timeouts (no import beyond this file: the CLI reads them without loading the tools). Re-exported by sageToolSession.ts. */

/**
 * How long a statement of a migration request may wait for a lock (B24-2): every other wait of the run is bounded (COMMIT, ROLLBACK, the
 * run lock, the number lock). A lock held by a session that never ends (a previous run's dry transaction left open) fails the request
 * after this, instead of hanging it.
 */
export const SAGE_LOCK_TIMEOUT_MS = 10_000;

/**
 * Round 25: no statement of the migration waits forever. Each request bounds its own statements (statement_timeout, above the lock
 * timeout), and the pool the CLI gives the run (sagePoolConfig) bounds every query client-side (query_timeout, above the statement
 * timeout: a half-open socket, which never errors, then surfaces as "Query read timeout") and keeps its sockets alive (TCP keepalive).
 */
export const SAGE_STATEMENT_TIMEOUT_MS = 60_000;
export const SAGE_QUERY_TIMEOUT_MS = 75_000;
export const SAGE_KEEPALIVE_INITIAL_DELAY_MS = 10_000;
export const sagePoolConfig = (connectionString: string | undefined) => ({
  connectionString, max: 4, keepAlive: true, keepAliveInitialDelayMillis: SAGE_KEEPALIVE_INITIAL_DELAY_MS, query_timeout: SAGE_QUERY_TIMEOUT_MS,
});
