// src/lib/auth/boundedPoolRead.ts
// One read that never holds, or waits long for, a slot of a small privileged pool. For the look-ups the
// unauthenticated Login-as end paths make (Sign Out, a refused Return): the platform_admin session record and the
// migration_admin stash row (#1371 review M1 / round 3).
import type pg from 'pg';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';

/** Waiting for a pool slot, and the statement itself. */
export const BOUNDED_CHECKOUT_MS = 1000;
export const BOUNDED_STATEMENT_MS = 2000;

/** The bounded read gave up (no pool slot in time); the caller treats the answer as unknown. */
export class SessionLookupBoundError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionLookupBoundError'; }
}

/**
 * Runs one read-only statement on `pool`, in a READ ONLY transaction (a write is refused by the server). Waits at most BOUNDED_CHECKOUT_MS for a connection (a pool's own connect
 * timeout is 15 s; a checkout that arrives late is released at once) and runs the statement under a
 * transaction-local statement_timeout of BOUNDED_STATEMENT_MS (the client-side query_timeout is longer, so the
 * server cancels first). Throws SessionLookupBoundError or the query's error; a connection whose ROLLBACK failed is
 * destroyed, not pooled.
 */
export async function boundedPoolRead<R extends pg.QueryResultRow>(
  pool: pg.Pool, label: string, text: string, values: unknown[],
): Promise<R[]> {
  const checkout = pool.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), BOUNDED_CHECKOUT_MS); });
  const client = await Promise.race([checkout, bound]).finally(() => clearTimeout(timer));
  if (!client) {
    checkout.then((late) => late.release(), (err: unknown) => log.warn(`${label}: late checkout failed`,
      { message: err instanceof Error ? err.message : String(err) }, 'Auth'));
    throw new SessionLookupBoundError(`${label}: no connection within ${BOUNDED_CHECKOUT_MS} ms`);
  }
  let unusable = false;
  try {
    await client.query('BEGIN READ ONLY'); // the helper can never commit a write, whatever text a caller passes
    await client.query(`SET LOCAL statement_timeout = ${BOUNDED_STATEMENT_MS}`);
    const { rows } = await client.query<R>({ text, values, query_timeout: BOUNDED_STATEMENT_MS + 1000 });
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    // R-176: a statement_timeout cancel aborts the transaction; a failed ROLLBACK leaves it open, so destroy it.
    unusable = await rollbackFailed(client, label);
    throw err;
  } finally {
    client.release(unusable);
  }
}
