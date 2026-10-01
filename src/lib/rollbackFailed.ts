// src/lib/rollbackFailed.ts
import { log } from '@/lib/logger';

/**
 * How long a ROLLBACK may take to answer. A healthy server answers in milliseconds. Five seconds
 * is far beyond a loaded one, and well inside the pools' 15 s checkout timeout, so a connection
 * that has stopped answering (a half-open socket, a query stuck ahead of it) gives its slot back
 * before the callers queued for it give up. No pool here sets a client-side query_timeout, so
 * without this bound the owner's `finally` would never run.
 */
export const ROLLBACK_TIMEOUT_MS = 5000;

/**
 * Rolls a transaction back and reports whether that FAILED (R-176). It never throws.
 *
 * A connection whose ROLLBACK did not complete may still be inside its transaction. Returned to
 * the pool, it hands that open (or aborted) transaction to the next caller, whose COMMIT then
 * lands the failed work. So every transaction owner passes this result to `client.release(...)`:
 * pg-pool destroys a client released with a truthy argument. A ROLLBACK that succeeds leaves a
 * reusable connection, and `false` keeps it.
 *
 * A ROLLBACK that has not answered within ROLLBACK_TIMEOUT_MS counts as failed and is abandoned.
 * Its promise stays handled, so a late rejection (the destroyed connection ends it with
 * "Connection terminated") cannot surface as an unhandled rejection.
 */
export async function rollbackFailed(
  client: { query(text: string): Promise<unknown> },
  source: string,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failure = await Promise.race([
    (async () => client.query('ROLLBACK'))().then(() => null, (err: unknown) => err ?? new Error('ROLLBACK rejected')),
    new Promise<Error>((resolve) => {
      timer = setTimeout(
        () => resolve(new Error(`ROLLBACK did not answer within ${ROLLBACK_TIMEOUT_MS}ms`)), ROLLBACK_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (failure === null) return false;
  log.error(`${source}: ROLLBACK failed, destroying the connection`, {
    message: failure instanceof Error ? failure.message : String(failure),
  }, 'DB');
  return true;
}
