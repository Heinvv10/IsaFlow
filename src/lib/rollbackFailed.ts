// src/lib/rollbackFailed.ts
import { log } from '@/lib/logger';
import { cancelBackend } from '@/lib/cancelBackend';

/**
 * How long a ROLLBACK may take to answer. A healthy server answers in milliseconds. Five seconds
 * is far beyond a loaded one, and well inside the pools' 15 s checkout timeout, so a connection
 * that has stopped answering (a half-open socket, a query stuck ahead of it) gives its slot back
 * before the callers queued for it give up. No pool here sets a client-side query_timeout, so
 * without this bound the owner's `finally` would never run.
 */
export const ROLLBACK_TIMEOUT_MS = 5000;
let boundMs = ROLLBACK_TIMEOUT_MS;
let warnedNoCancel = false;

/**
 * Test seam: shortens the bound and returns the restore. It throws unless NODE_ENV is 'test'.
 * Next.js inlines NODE_ENV at build time, so in the server bundle this is an unconditional
 * throw; a script would have to be started with NODE_ENV=test to get past it.
 */
export function setRollbackBoundForTests(ms: number): () => void {
  if (process.env.NODE_ENV !== 'test') throw new Error('setRollbackBoundForTests works only in a test run (NODE_ENV=test)');
  boundMs = ms;
  return () => { boundMs = ROLLBACK_TIMEOUT_MS; };
}

interface Rollbackable { query(text: string): Promise<unknown> }

/**
 * Rolls a transaction back and returns the error if that FAILED, else null (R-176). Never throws.
 *
 * A ROLLBACK that has not answered within ROLLBACK_TIMEOUT_MS counts as failed and is abandoned.
 * Its promise stays handled, so a late rejection (the destroyed connection ends it with
 * "Connection terminated") cannot surface as an unhandled rejection.
 *
 * On a failure the caller is about to destroy the connection, which does not stop a statement
 * still running on the server, so the backend is asked to cancel it first (cancelBackend).
 */
export async function rollbackError(client: Rollbackable, source: string): Promise<Error | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = boundMs;
  const noAnswer = new Error(`ROLLBACK did not answer within ${bound}ms`);
  const failure = await Promise.race([
    (async () => client.query('ROLLBACK'))().then(() => null, (err: unknown) => err ?? new Error('ROLLBACK rejected')),
    new Promise<Error>((resolve) => {
      timer = setTimeout(() => resolve(noAnswer), bound);
      timer.unref?.(); // must not keep a script alive
    }),
  ]);
  clearTimeout(timer);
  if (failure === null) return null;
  const error = failure instanceof Error ? failure : new Error(String(failure));
  log.error(`${source}: ROLLBACK failed, destroying the connection`, { message: error.message }, 'DB');
  let cancelSent = false;
  try {
    cancelSent = cancelBackend(client);
  } catch (cancelErr) {
    log.error(`${source}: backend cancel failed`, { message: cancelErr instanceof Error ? cancelErr.message : String(cancelErr) }, 'DB');
  }
  if (!cancelSent && failure === noAnswer && !warnedNoCancel) {
    // Something was in flight and nothing could be sent to stop it (not a connected pg client, or
    // node-postgres no longer exposes what cancelBackend reads). Said once per process.
    warnedNoCancel = true;
    log.warn(`${source}: cannot cancel the backend of a connection that stopped answering; its statement runs on`, {}, 'DB');
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
