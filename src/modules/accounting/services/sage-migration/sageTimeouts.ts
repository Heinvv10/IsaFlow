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
/**
 * How long a COMMIT may take to answer (R26-8): above the statement timeout and below the client query_timeout, so on the CLI's pool THIS
 * bound is the one that fires on a COMMIT ("COMMIT did not answer within 70000ms": unconfirmed). It is also the ONLY bound on a COMMIT's
 * deferred work (B28-2): PostgreSQL runs deferred triggers and constraints after the statement timer is off, so statement_timeout never
 * cancels them.
 */
export const SAGE_COMMIT_TIMEOUT_MS = 70_000;
export const SAGE_QUERY_TIMEOUT_MS = 75_000;
/** How long a connection may take to be had (B26-1, R26-2): pg's default waits for ever on a server that accepts and never answers. */
export const SAGE_CONNECT_TIMEOUT_MS = 15_000;
export const SAGE_KEEPALIVE_INITIAL_DELAY_MS = 10_000;
/** How long the CLI waits for its pool to close before it exits anyway (B26-1): its result is already printed and written. */
export const SAGE_POOL_END_TIMEOUT_MS = 5_000;
/**
 * The application_name of the CLI's connections (R27-3, B29-3): `isaflow-sage-migration:<company id>`. A lock holder with THIS company's
 * name is one of this company's migration sessions, the only kind ever offered for ending; another company's run (a batch key may share
 * the registry's 32-bit hashtext space) or any other client is someone else's to end.
 */
export const SAGE_APP_NAME = 'isaflow-sage-migration';
export const sageAppName = (companyId: string): string => `${SAGE_APP_NAME}:${companyId.toLowerCase()}`;
export const sagePoolConfig = (connectionString: string | undefined, companyId: string) => ({
  connectionString, max: 4, keepAlive: true, keepAliveInitialDelayMillis: SAGE_KEEPALIVE_INITIAL_DELAY_MS, query_timeout: SAGE_QUERY_TIMEOUT_MS,
  connectionTimeoutMillis: SAGE_CONNECT_TIMEOUT_MS, application_name: sageAppName(companyId),
});
