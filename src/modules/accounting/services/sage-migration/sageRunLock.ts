/**
 * One Sage migration per company at a time. A session advisory lock is held on a connection of its own for the whole run, dry run included:
 * two runs of one company at once would each plan from the same snapshot, claim the same rows, and both report them as added. A second
 * run is refused at its start (RunInProgressError) and writes nothing; another company is not held up. The lock goes with its connection
 * if the process dies.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConnectionLostError } from './sageSessionErrors';
import { watchWaits } from './sageWaitWatch';
import { asError, told, OwnError } from './sageTold';
import { log } from '@/lib/logger';
import { safeLog } from './sageSessionRead';

export class RunInProgressError extends OwnError {}

/**
 * Taking the run lock failed on its own connection (B28-6): its try-lock (or the session setting after it) did not answer or failed.
 * Nothing was written. On a half-open link the try-lock may still have been GRANTED server-side, so its backend (`pid`) may hold the run
 * lock until the server drops that connection; a re-run is then refused as running, naming that pid.
 */
export class RunLockNotTakenError extends OwnError {
  constructor(cause: Error, readonly pid: number | undefined) {
    super(`the run lock could not be taken (${told(cause)}): nothing was written; ${pid === undefined ? 'its backend pid is unknown' : `its backend pid ${pid} may hold the run lock until the server drops that connection: if a re-run is refused as running, SELECT pg_terminate_backend(${pid})`}`, { cause });
    this.name = 'RunLockNotTakenError';
  }
}

/**
 * A release of the lock connection that threw (B38-2: a pool wrapper): said, and returned as the Error to release it again with (a truthy
 * release: pg destroys the connection, and its session lock with it). The caller's own outcome stands; nothing here throws.
 */
const releaseThrew = (raw: unknown): Error => {
  const e = asError(raw);
  safeLog('releasing the run lock connection failed', e);
  return e;
};
const DESTROY_FAILED = 'destroying the run lock connection failed';

const int32 = (text: string): number => createHash('sha256').update(text).digest().readInt32BE(0);

/** The two int4 keys of the company's lock (pg_try_advisory_lock(int4, int4)). */
export function migrationLockKey(companyId: string): [number, number] {
  return [int32('sage-migration'), int32(`sage-migration:${companyId.toLowerCase()}`)];
}

/** How often the idle lock connection is pinged: a proxy or firewall that drops idle sessions would otherwise take the lock without a word. */
export const KEEPALIVE_MS = 15_000;
/** A probe of the lock connection that has not answered in this long counts as lost: a half-open connection never errors. */
export const CHECK_TIMEOUT_MS = 10_000;

export class LockLostError extends OwnError {}

export interface RunLock {
  /** Gives the lock up (call it in a `finally`). Returns a warning when its release was not confirmed (B25-3), else null. */
  unlock: () => Promise<string | null>;
  /** Throws LockLostError when the lock's connection is gone: the run is no longer the only one for this company. Probes the connection. */
  check: () => Promise<void>;
  /** The same, from what the connection's 'error' event and the pings already recorded (no query): cheap enough to ask before every batch. */
  held: () => void;
}

/**
 * Takes the lock or throws RunInProgressError. The connection holds no transaction, only the session lock; whenever a query on it failed
 * it is released WITH that error, so pg destroys it (a destroyed connection drops its session lock, which is what must happen to one
 * whose unlock did not run). The connection sits idle for the whole run, so it is WATCHED: an 'error' listener records a backend that
 * dropped it (without one, pg's emitter would throw into the process and kill the run with no summary), and `check()` probes it, so the
 * runner can stop between phases when the lock is gone. The listener is removed on release. Taking it is watched like every request of
 * the run (R27-6): a connect or a query of it with no answer is said to `onNotice` every 5 s.
 */
export async function acquireRunLock(pool: Pool, companyId: string, onNotice?: (line: string) => void): Promise<RunLock> {
  const watch = watchWaits(pool, onNotice);
  try {
    return await takeRunLock(pool, companyId, async (run) => { const done = watch.begin(); try { return await run(); } finally { done(); } });
  } finally {
    watch.stop();
  }
}

async function takeRunLock(pool: Pool, companyId: string, watched: <T>(run: () => Promise<T>) => Promise<T>): Promise<RunLock> {
  const [k1, k2] = migrationLockKey(companyId);
  let client: PoolClient;
  try {
    client = await watched(() => pool.connect()); // bounded by the pool's connectionTimeoutMillis (B26-1): a server that never answers is said
  } catch (err) {
    throw new ConnectionLostError(err, 'no-connection');
  }
  let lost: Error | undefined;
  const onError = (err: Error) => { lost = err; };
  client.on('error', onError);
  const processID: unknown = (client as unknown as { processID?: unknown }).processID;
  const pid = typeof processID === 'number' ? processID : undefined;
  let failure: Error | undefined;
  let gotLock = false;
  try {
    gotLock = (await watched(() => client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::int, $2::int) AS ok', [k1, k2]))).rows[0]?.ok === true;
  } catch (err) {
    failure = asError(err);
  }
  if (failure || !gotLock) {
    // Who holds it (B25-3): a running run, or a dead run's connection the server has not dropped yet. Best effort: unknown is said so.
    let holder: number | undefined;
    let lookupFailure: Error | undefined;
    if (!failure) {
      try {
        const h = await watched(() => client.query<{ pid: number }>(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND pid <> pg_backend_pid()
          AND classid = ($1::int::bigint & 4294967295)::oid AND objid = ($2::int::bigint & 4294967295)::oid LIMIT 1`, [k1, k2]));
        holder = h.rows[0]?.pid;
      } catch (err) {
        // R26-10: the connection goes back WITH this error (pg destroys it): a lookup that timed out may still be running on it.
        lookupFailure = asError(err);
        log.warn('sage migration: the run lock holder could not be read', { message: told(lookupFailure) }, 'sage-migration');
      }
    }
    // One release for both: with the error when a query failed (pg destroys the connection), plain when someone else holds the lock (it is fine).
    client.removeListener('error', onError);
    let back = failure ?? lookupFailure;
    try { client.release(back); } catch (raw) { back = releaseThrew(raw); try { client.release(back); } catch (again) { safeLog(DESTROY_FAILED, again); } }
    const who = holder === undefined ? 'its holder\'s backend pid unknown' : `held by backend pid ${holder}; if no run is running, that is a dead run's connection: SELECT pg_terminate_backend(${holder})`;
    if (failure) throw new RunLockNotTakenError(failure, pid);
    throw new RunInProgressError(`another Sage migration is running for this company (${companyId}; ${who}): wait for it to finish, then run again; nothing was written`);
  }
  // The server may end an idle session (idle_session_timeout, set per role or database): this one idles for the whole run, so for this
  // session only it is off. A failure here is a failure of the connection like any other.
  try {
    await watched(() => client.query('SET idle_session_timeout = 0'));
  } catch (err) {
    failure = asError(err);
    client.removeListener('error', onError);
    let back: Error = failure;
    try { client.release(back); } catch (raw) { back = releaseThrew(raw); try { client.release(back); } catch (again) { safeLog(DESTROY_FAILED, again); } }
    throw new RunLockNotTakenError(failure, pid);
  }
  /** A query on the lock connection that gives up after CHECK_TIMEOUT_MS: a half-open connection never answers and never errors. */
  const bounded = async <T,>(run: () => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${CHECK_TIMEOUT_MS / 1000} s`)), CHECK_TIMEOUT_MS); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const lostError = (): LockLostError => new LockLostError(`lock lost (${lost === undefined ? 'unknown' : told(lost)}): the run lock is gone, so another run could now start for this company, and this one stops`);
  const held = (): void => { if (lost) throw lostError(); };
  const check = async (): Promise<void> => {
    if (!lost) {
      try {
        await bounded(() => client.query('SELECT 1'));
      } catch (err) {
        lost = asError(err);
      }
    }
    held();
  };
  const keepalive = setInterval(() => { check().catch(() => undefined); }, KEEPALIVE_MS); // a failed ping records the loss (check() sets it)
  keepalive.unref();
  const unlock = async (): Promise<string | null> => {
    clearInterval(keepalive);
    let unlockFailure: Error | undefined = lost;
    if (!lost) {
      try {
        const unlocked = await bounded(() => client.query<{ ok: boolean }>('SELECT pg_advisory_unlock($1::int, $2::int) AS ok', [k1, k2]));
        if (unlocked.rows[0]?.ok !== true) log.error('sage migration: the run lock was not held at unlock', { companyId }, 'sage-migration');
        await bounded(() => client.query('RESET idle_session_timeout')); // the connection goes back to the pool as the server configured it
      } catch (err) {
        unlockFailure = asError(err);
      }
    }
    client.removeListener('error', onError);
    try {
      client.release(unlockFailure);
    } catch (raw) {
      unlockFailure = releaseThrew(raw); // the lock's fate is not known: said as not confirmed
      try { client.release(unlockFailure); } catch (again) { safeLog(DESTROY_FAILED, again); }
    }
    if (!unlockFailure) return null;
    const pid = typeof processID === 'number' ? `backend pid ${processID}: if a re-run is refused as running, it still holds it: SELECT pg_terminate_backend(${processID})` : 'backend pid unknown';
    return `its run lock release was not confirmed (${told(unlockFailure)}); ${pid}`;
  };
  return { unlock, check, held };
}
