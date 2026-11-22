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

export class LockLostError extends Error {}

export interface RunLock {
  /** Gives the lock up (call it in a `finally`). */
  unlock: () => Promise<void>;
  /** Throws LockLostError when the lock's connection is gone: the run is no longer the only one for this company. */
  check: () => Promise<void>;
}

/**
 * Takes the lock or throws RunInProgressError. The connection holds no transaction, only the session lock; whenever a query on it failed
 * it is released WITH that error, so pg destroys it (a destroyed connection drops its session lock, which is what must happen to one
 * whose unlock did not run). The connection sits idle for the whole run, so it is WATCHED: an 'error' listener records a backend that
 * dropped it (without one, pg's emitter would throw into the process and kill the run with no summary), and `check()` probes it, so the
 * runner can stop between phases when the lock is gone. The listener is removed on release.
 */
export async function acquireRunLock(pool: Pool, companyId: string): Promise<RunLock> {
  const [k1, k2] = migrationLockKey(companyId);
  const client = await pool.connect();
  let lost: Error | undefined;
  const onError = (err: Error) => { lost = err; };
  client.on('error', onError);
  let failure: Error | undefined;
  let held = false;
  try {
    held = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::int, $2::int) AS ok', [k1, k2])).rows[0]?.ok === true;
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  }
  if (failure) {
    client.removeListener('error', onError);
    client.release(failure);
    throw failure;
  }
  if (!held) {
    client.removeListener('error', onError);
    client.release(failure);
    throw new RunInProgressError(`another Sage migration is running for this company (${companyId}): wait for it to finish, then run again; nothing was written`);
  }
  const check = async (): Promise<void> => {
    if (!lost) {
      try {
        await client.query('SELECT 1');
      } catch (err) {
        lost = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (lost) throw new LockLostError(`lock lost (${lost.message}): the run lock is gone, so another run could now start for this company, and this one stops`);
  };
  const unlock = async (): Promise<void> => {
    let unlockFailure: Error | undefined = lost;
    if (!lost) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [k1, k2]);
      } catch (err) {
        unlockFailure = err instanceof Error ? err : new Error(String(err));
      }
    }
    client.removeListener('error', onError);
    client.release(unlockFailure);
  };
  return { unlock, check };
}
