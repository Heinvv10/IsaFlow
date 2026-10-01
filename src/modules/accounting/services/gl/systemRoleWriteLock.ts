/**
 * The one lock every writer of a company's role holders takes first — before
 * it reads the state it decides on, and before any gl_accounts row lock: the
 * Default Accounts save, the COA import's role map, the migration rollback,
 * the template seed, the Opening Balance Equity auto-create, an account
 * (de)activation / delete / reclassify, the bank-account (de)activation, and
 * (through `lockGlAccountsForUpdate`) the account merge.
 * Without it two saves on a company whose chart carries no role yet both
 * committed 200s (a FOR UPDATE on the role rows locks nothing when there are
 * none), and any of the others could change a holder between a save's read and
 * its write.
 *
 * EXCLUSIVE and transaction-scoped: released at COMMIT/ROLLBACK, so `q` must
 * run on the writer's own transaction — through the pool it is released at
 * once and only orders this call after the writers already in flight.
 *
 * Bounded: a holder that hangs must not hang every other role writer with it.
 * The 5s `lock_timeout` is set in the SAME statement (CASE fixes the order) so
 * it also binds on a pooled connection, and the caller's own value is restored
 * once the lock is granted so no later statement inherits it. A timeout is
 * 55P03: it aborts the transaction (or the enclosing savepoint), so callers
 * answer 5xx/retry.
 */
import { sql } from '@/lib/neon';
import type { SqlExec } from './journalVatLockGuard';

/**
 * `lock_not_available` (the 5s `lock_timeout` elapsed) and `deadlock_detected`.
 * A deadlock victim is in the same position as a timed-out waiter — its
 * transaction is aborted, nothing it did stands, and a retry will succeed —
 * so both reach the caller as the same typed, retryable refusal (503), never
 * as a 500. A cycle can still form when an EARLIER statement of the same
 * transaction row-locked an account without the role lock (an MCP batch: a
 * bill line's FOR SHARE, then an account tool); the role lock taken first by
 * every gl_accounts writer removes the cycles the chart itself could make.
 */
const RETRYABLE_LOCK_ERRORS = new Set(['55P03', '40P01']);
const isRetryableLockError = (err: unknown) =>
  RETRYABLE_LOCK_ERRORS.has(String((err as { code?: unknown } | null)?.code ?? ''));

/** Another request held the company's role-write lock for longer than 5s. */
export class SystemRoleLockTimeoutError extends Error {
  readonly code = 'SYSTEM_ROLE_LOCK_TIMEOUT';
  constructor() {
    super('The chart of accounts is being changed by another request — retry in a moment.');
    this.name = 'SystemRoleLockTimeoutError';
  }
}

/**
 * Run a lock-taking statement under the 5s bound, restoring the caller's own
 * `lock_timeout` after. A timeout is 55P03 — the transaction (or the enclosing
 * savepoint) is aborted — and is rethrown typed, so callers answer 5xx/retry.
 */
export async function withBoundedLockWait<T>(q: SqlExec, take: () => PromiseLike<T>): Promise<T> {
  const prev = (await q`SELECT current_setting('lock_timeout') AS v`) as { v?: unknown }[];
  await q`SELECT set_config('lock_timeout', '5s', true)`;
  let failure: unknown = null;
  try {
    return await take();
  } catch (err) {
    failure = err;
    if (isRetryableLockError(err)) throw new SystemRoleLockTimeoutError();
    throw err;
  } finally {
    // A database error has aborted the transaction (or the enclosing
    // savepoint, whose rollback restores the setting); anything else leaves
    // it usable, and later waits of the request must not inherit the 5s.
    const sqlState = typeof (failure as { code?: unknown } | null)?.code === 'string'
      && /^[0-9A-Z]{5}$/.test((failure as { code: string }).code);
    if (!sqlState) await q`SELECT set_config('lock_timeout', ${String(prev[0]?.v ?? '0')}, true)`;
  }
}

export async function lockSystemRoleWrites(companyId: string, q: SqlExec = sql): Promise<void> {
  const prev = (await q`SELECT current_setting('lock_timeout') AS v`) as { v?: unknown }[];
  try {
    await q`
      SELECT CASE WHEN set_config('lock_timeout', '5s', true) IS NOT NULL
        THEN pg_advisory_xact_lock(hashtextextended(${`default-accounts:${companyId}`}::TEXT, 0))::TEXT END`;
  } catch (err) {
    if (isRetryableLockError(err)) throw new SystemRoleLockTimeoutError();
    throw err;
  }
  await q`SELECT set_config('lock_timeout', ${String(prev[0]?.v ?? '0')}, true)`;
}
