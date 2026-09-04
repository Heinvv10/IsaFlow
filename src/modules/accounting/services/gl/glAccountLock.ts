/**
 * Row-lock helper for the gl_accounts WRITE paths.
 *
 * Modelled on `bank/bankTxLock.ts` and deliberately not a second idiom: that
 * helper was added after a double-post got through the same check-then-act
 * window, and the reclassification workstream needs the identical thing on the
 * same table. One pattern, one place.
 *
 * The window here: a merge (and a reclassification) reads an account, refuses on
 * its state, and then rewrites it. `merge(A -> B)` and `merge(B -> A)` arrive
 * with different idempotency keys, so the registry's per-key lock never sees
 * them as the same call. Under READ COMMITTED each passes every guard against
 * its own snapshot, each moves its own lines, and both set `is_active = false` —
 * leaving the combined balance stranded across two dead accounts.
 *
 * Since PR #264 every request runs inside a single transaction on the
 * AsyncLocalStorage-bound client, so `FOR UPDATE` taken here is held for the
 * rest of the request: the second request blocks until the first commits, then
 * re-reads the settled row and refuses.
 *
 * Write paths ONLY — never call this from a list/query service.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds one of the accounts longer than the 5s
 * `lock_timeout`. The MCP tool surfaces the message, so it has to say "retry".
 *
 * The timeout is the point, not a detail: without one, a merge that blocks
 * behind a long-running transaction on a control account waits indefinitely
 * INSIDE the registry's savepoint, pinning the connection. Something is writing
 * to Velocity's `1120` and `2110` unattended right now, and a merge is exactly
 * the operation that would collide with it.
 */
export class GlAccountLockTimeoutError extends Error {
  readonly code = 'GL_ACCOUNT_LOCK_TIMEOUT';
  constructor(accountId: string) {
    super(`GL account ${accountId} is being changed by another request — retry in a moment.`);
    this.name = 'GlAccountLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/**
 * Lock one or more GL accounts for the rest of the surrounding transaction, in
 * ASCENDING ID ORDER. Returns the rows found; a missing or foreign id simply
 * does not appear, so callers keep their own NOT_FOUND wording.
 *
 * The ordering is what turns two opposite merges into a clean wait instead of a
 * 40P01 deadlock, and it is done by ISSUING ONE STATEMENT PER ID in sorted
 * order rather than by a single `ORDER BY id ... FOR UPDATE`. A single statement
 * does currently lock in id order on this schema — `LockRows` sits above an
 * index scan on `gl_accounts_id_company_uq` — but that is a property of the
 * plan the planner happens to choose, and a lock ordering that depends on a
 * plan shape is not an ordering. Two round trips for two accounts is the
 * cheaper mistake.
 *
 * Throws if no request transaction is in flight: outside one, every statement is
 * its own implicit transaction, so `FOR UPDATE` releases the instant the SELECT
 * returns and the caller believes it is serialised when it is not.
 *
 * The 5s `lock_timeout` is re-issued on EVERY call, not memoised per request.
 * `SET LOCAL` is subtransaction-aware: `ROLLBACK TO SAVEPOINT` restores the
 * previous value, which is `0` — no timeout at all. Every MCP tool call runs in
 * a savepoint that rolls back on failure, so a per-connection cache would leave
 * later locks waiting forever exactly where contention is likeliest.
 */
export async function lockGlAccountsForUpdate(
  companyId: string,
  accountIds: readonly string[],
): Promise<DbRow[]> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'lockGlAccountsForUpdate requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }

  // Issued on the request client directly, not through `sql`: a transaction
  // setting rather than a tenant query. Because it bypasses `sql` it also
  // bypasses that path's usability check, so a connection aborted by an earlier
  // failed savepoint would answer with a bare 25P02 before the guarded SELECT
  // below is reached.
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");

  const ordered = [...new Set(accountIds)].sort();
  const rows: DbRow[] = [];
  for (const id of ordered) {
    try {
      const found = (await sql`
        SELECT * FROM gl_accounts
         WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
         FOR UPDATE`) as DbRow[];
      if (found[0]) rows.push(found[0]);
    } catch (err) {
      if (isLockTimeout(err)) throw new GlAccountLockTimeoutError(id);
      throw err;
    }
  }
  return rows;
}
