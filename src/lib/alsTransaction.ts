/**
 * A transaction that every nested `sql` call joins.
 *
 * Lives outside `neon.ts` deliberately: that file is already well over the
 * 300-line cap, and this is a self-contained policy about commit boundaries
 * rather than part of the query client.
 */

import { getPool } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';
import { log } from '@/lib/logger';

/**
 * Run `fn` in one transaction that every nested `sql` call joins.
 *
 * The difference from `withTransaction` is the ALS binding, and it is the whole
 * point: `withTransaction` hands its callback a `tx` function, so code the
 * callback CALLS still reaches the pool on its own connection and commits
 * independently. That is fine for a self-contained batch and wrong for a
 * service that composes other services — a crash part-way leaves the earlier
 * statements committed.
 *
 * `withTransaction` itself was deliberately NOT changed to bind ALS. Every
 * out-of-request caller in the codebase would inherit different commit
 * boundaries in one step, which is not a change to make as a side effect of a
 * bug fix. This is the opt-in version; widening it is a separate decision.
 *
 * Inside a request there is already such a transaction on the ALS client and
 * `fn` simply runs on it — opening a second would take another pool client and
 * deadlock against the rows this request already holds.
 *
 * `actor` becomes the synthetic request context, so anything nested that reads
 * `requireCtx()` sees the caller's real tenant and user rather than
 * placeholders. It is an OBJECT rather than two positional strings on purpose:
 * both are plain `string`, so a transposed pair would type-check and quietly
 * bind a company id as the user id.
 *
 * It sets no RLS GUCs — no `request.jwt.claims`, no `app.current_company_id`,
 * unlike `withAuth` and the bearer pipeline. Passing a `companyId` configures
 * the CONTEXT, not the database session, so every statement inside must still
 * carry its own `company_id` predicate. That matches what out-of-request
 * callers had before, where `sql` reached the pool with no GUCs at all.
 */
export interface AlsTransactionActor {
  userId: string;
  companyId: string | undefined;
}

export async function withAlsTransaction<T>(
  actor: AlsTransactionActor,
  fn: () => Promise<T>,
): Promise<T> {
  const { userId, companyId } = actor;
  if (als.getStore()?.client) {
    assertTxUsable();
    return fn();
  }

  const client = await getPool().connect();
  let poisoned = false;
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId, companyId, claims: {} }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // A connection whose ROLLBACK failed is in an unknown state. Returning it
      // to the pool hands the next caller an aborted transaction; destroy it.
      poisoned = true;
      log.error('withAlsTransaction: ROLLBACK failed, destroying the connection', { error: rollbackErr }, 'DB');
    }
    throw err;
  } finally {
    client.release(poisoned ? new Error('rollback failed') : undefined);
  }
}
