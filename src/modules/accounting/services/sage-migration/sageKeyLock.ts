/**
 * The idempotency lock of a write tool's call, taken by the migration's own session WITHOUT waiting before the registry takes it (B24-2):
 * a key another session holds is said at once, with that session's pid, instead of the registry waiting on it. Taken by this transaction,
 * the registry's own wait on it then returns at once (advisory locks stack within a session).
 */
import { BatchKeyHeldError, type LockPhase } from './sageSessionErrors';

/**
 * The text the registry locks (src/lib/mcp/registry.ts + audit.ts acquireIdempotencyLock), built the same way (R25-8): the key trimmed,
 * and for a per-user tool namespaced by the caller. Pinned against the registry by sageKeyLockText.test.ts.
 */
export function idempotencyLockText(companyId: string, tool: string, key: string, perUserUserId?: string): string {
  const supplied = key.trim();
  return `mcp:${companyId}:${tool}:${perUserUserId === undefined ? supplied : `u:${perUserUserId}:${supplied}`}`;
}

/** Who holds an xact advisory lock of hashtext(text) (objsubid 1: the one-bigint form), other than this backend (R25-5). */
export const HOLDER_SQL = `SELECT l.pid FROM pg_locks l, (SELECT hashtext($1)::bigint AS k) x
    WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1 AND l.pid <> pg_backend_pid()
      AND l.classid = ((x.k >> 32) & 4294967295)::oid AND l.objid = (x.k & 4294967295)::oid LIMIT 1`;

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

export async function takeKeyLockNow(client: Queryable, lockText: string, phase: LockPhase): Promise<void> {
  const got = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS ok', [lockText]);
  if (got.rows[0]?.ok !== false) return;
  const holder = await client.query(HOLDER_SQL, [lockText]);
  const pid = holder.rows[0]?.pid;
  throw new BatchKeyHeldError(typeof pid === 'number' ? pid : undefined, phase);
}
