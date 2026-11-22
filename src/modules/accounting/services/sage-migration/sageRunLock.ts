/**
 * One Sage migration per company at a time. A session advisory lock is held on a connection of its own for the whole run, dry run included:
 * two runs of one company at once would each plan from the same snapshot, claim the same rows, and both report them as added. A second
 * run is refused at its start (RunInProgressError) and writes nothing; another company is not held up. The lock goes with its connection
 * if the process dies.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export class RunInProgressError extends Error {}

const int32 = (text: string): number => createHash('sha256').update(text).digest().readInt32BE(0);

/** The two int4 keys of the company's lock (pg_try_advisory_lock(int4, int4)). */
export function migrationLockKey(companyId: string): [number, number] {
  return [int32('sage-migration'), int32(`sage-migration:${companyId.toLowerCase()}`)];
}

/**
 * Takes the lock or throws RunInProgressError. Returns the function that releases it (call it in a `finally`). The connection holds no
 * transaction, only the session lock; whenever a query on it failed it is released WITH that error, so pg destroys it (a destroyed
 * connection drops its session lock, which is what must happen to one whose unlock did not run).
 */
export async function acquireRunLock(pool: Pool, companyId: string): Promise<() => Promise<void>> {
  const [k1, k2] = migrationLockKey(companyId);
  const client = await pool.connect();
  let failure: Error | undefined;
  let held = false;
  try {
    held = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::int, $2::int) AS ok', [k1, k2])).rows[0]?.ok === true;
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  }
  if (failure) {
    client.release(failure);
    throw failure;
  }
  if (!held) {
    client.release(failure);
    throw new RunInProgressError(`another Sage migration is running for this company (${companyId}): wait for it to finish, then run again; nothing was written`);
  }
  return async () => {
    let unlockFailure: Error | undefined;
    try {
      await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [k1, k2]);
    } catch (err) {
      unlockFailure = err instanceof Error ? err : new Error(String(err));
    }
    client.release(unlockFailure);
  };
}
