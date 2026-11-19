/**
 * One provisioning run at a time, per database. A session-level advisory lock on the run's own connection, held from before the
 * first GoTrue write to after the env file is written: a second run (a cron, a second terminal) is refused at once rather
 * than racing the first into two companies or two passwords. The database step takes a transaction-level lock of its own
 * as well (provisionDb.ts), which holds even for a caller that skipped this one.
 */
import type { ClientBase } from 'pg';

/** The lock's key, one number for both locks: hashtext of this name. */
export const LOCK_NAME = 'provision-verify-company';

/** @returns false when another run holds it. */
export async function tryRunLock(db: ClientBase): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_NAME]);
  return r.rows[0]?.ok === true;
}

export async function releaseRunLock(db: ClientBase): Promise<void> {
  await db.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]);
}

/** Inside the database transaction: waits for a concurrent run's transaction, released at COMMIT or ROLLBACK. */
export async function lockTransaction(db: ClientBase): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_NAME]);
}
