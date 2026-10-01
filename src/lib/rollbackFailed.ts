// src/lib/rollbackFailed.ts
import { log } from '@/lib/logger';
import { cancelBackend } from '@/lib/cancelBackend';

/**
 * How long a ROLLBACK may take to answer. A healthy server answers in milliseconds. Five seconds
 * is far beyond a loaded one, and well inside the pools' 15 s checkout timeout, so a connection
 * that has stopped answering (a half-open socket, a query stuck ahead of it) gives its slot back
 * before the callers queued for it give up. No pool here sets a client-side query_timeout, so
 * without this bound the owner's `finally` would never run.
 *
 * An object so a test can shorten it; nothing in production writes it.
 */
export const rollbackBound = { ms: 5000 };

interface Rollbackable { query(text: string): Promise<unknown> }

/**
 * Rolls a transaction back and returns the error if that FAILED, else null (R-176). Never throws.
 *
 * A ROLLBACK that has not answered within rollbackBound.ms counts as failed and is abandoned.
 * Its promise stays handled, so a late rejection (the destroyed connection ends it with
 * "Connection terminated") cannot surface as an unhandled rejection.
 *
 * On a failure the caller is about to destroy the connection, which does not stop a statement
 * still running on the server, so the backend is asked to cancel it first (cancelBackend).
 */
export async function rollbackError(client: Rollbackable, source: string): Promise<Error | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = rollbackBound.ms;
  const failure = await Promise.race([
    (async () => client.query('ROLLBACK'))().then(() => null, (err: unknown) => err ?? new Error('ROLLBACK rejected')),
    new Promise<Error>((resolve) => {
      timer = setTimeout(() => resolve(new Error(`ROLLBACK did not answer within ${bound}ms`)), bound);
    }),
  ]);
  clearTimeout(timer);
  if (failure === null) return null;
  const error = failure instanceof Error ? failure : new Error(String(failure));
  log.error(`${source}: ROLLBACK failed, destroying the connection`, { message: error.message }, 'DB');
  try {
    cancelBackend(client);
  } catch (cancelErr) {
    log.error(`${source}: backend cancel failed`, { message: cancelErr instanceof Error ? cancelErr.message : String(cancelErr) }, 'DB');
  }
  return error;
}

/**
 * Rolls a transaction back and reports whether that FAILED (R-176). It never throws.
 *
 * A connection whose ROLLBACK did not complete may still be inside its transaction. Returned to
 * the pool, it hands that open (or aborted) transaction to the next caller, whose COMMIT then
 * lands the failed work. So every transaction owner passes this result to `client.release(...)`:
 * pg-pool destroys a client released with a truthy argument. A ROLLBACK that succeeds leaves a
 * reusable connection, and `false` keeps it.
 */
export async function rollbackFailed(client: Rollbackable, source: string): Promise<boolean> {
  return (await rollbackError(client, source)) !== null;
}
