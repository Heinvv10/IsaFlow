/**
 * The idempotency lock of a write tool's call, taken by the migration's own session WITHOUT waiting before the registry takes it (B24-2):
 * a key another session holds is said at once, with that session's pid, instead of the registry waiting on it. Taken by this transaction,
 * the registry's own wait on it then returns at once (advisory locks stack within a session).
 */
import { log } from '@/lib/logger';
import { told } from './sageTold';
import { confirmIdle, HOLDER_COLUMNS, HOLDER_CONFIRM_MS, holderFrom, idleInTransaction } from './sageLockHolder';
import { BatchKeyHeldError, type LockPhase } from './sageSessionErrors';

/**
 * The text the registry locks (src/lib/mcp/registry.ts + audit.ts acquireIdempotencyLock), built the same way (R25-8): the key trimmed,
 * and for a per-user tool namespaced by the caller. Pinned against the registry by sageKeyLockText.test.ts.
 */
export function idempotencyLockText(companyId: string, tool: string, key: string, perUserUserId?: string): string {
  const supplied = key.trim();
  return `mcp:${companyId}:${tool}:${perUserUserId === undefined ? supplied : `u:${perUserUserId}:${supplied}`}`;
}

/**
 * Who holds an xact advisory lock of hashtext(text) (objsubid 1: the one-bigint form), other than this backend (R25-5), with its state,
 * application and transaction age (R26-4, R27-3: what decides the advice, sageLockHolder.ts).
 */
export const HOLDER_SQL = `SELECT ${HOLDER_COLUMNS} FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid,
      (SELECT hashtext($1)::bigint AS k) x
    WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1 AND l.pid <> pg_backend_pid()
      AND l.classid = ((x.k >> 32) & 4294967295)::oid AND l.objid = (x.k & 4294967295)::oid LIMIT 1`;

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

/**
 * `lookup` reads who holds it: the pool, not the request's own connection, which runs as app_user and so may not see another session's
 * state in pg_stat_activity. A lookup that fails is logged and said as "could not be read" (R27-7); the held key is said all the same.
 * A holder that looks like a migration transaction left open (our application, idle in a transaction) is looked up once more after
 * `o.confirmMs` (HOLDER_CONFIRM_MS): only one still idle with its state unchanged can be offered for ending (R28-4). `o.runLockAt`: when
 * this run took its run lock.
 */
export async function takeKeyLockNow(client: Queryable, lookup: Queryable, lockText: string, phase: LockPhase, o: { runLockAt?: number; appName?: string; confirmMs?: number } = {}): Promise<void> {
  const got = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS ok', [lockText]);
  if (got.rows[0]?.ok !== false) return;
  let unread = false;
  const read = () => lookup.query(HOLDER_SQL, [lockText]).then((r) => holderFrom(r.rows[0], o), (err: unknown) => {
    unread = true;
    log.warn('sage migration: who holds the batch key could not be read', { message: told(err) }, 'sage-migration');
    return undefined;
  });
  const at = Date.now();
  let holder = await read();
  if (holder !== undefined && holder.ours === true && idleInTransaction(holder.state) && holder.olderThanRun === true) {
    const apart = o.confirmMs ?? HOLDER_CONFIRM_MS;
    const first = { holder, at };
    await new Promise((r) => { setTimeout(r, apart); });
    const again = await read();
    holder = again === undefined ? holder : confirmIdle(first, again, Date.now(), apart);
  }
  throw new BatchKeyHeldError(holder, phase, unread);
}
