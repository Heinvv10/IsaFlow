/**
 * The one lock every writer of a company's role holders takes first — before
 * it reads the state it decides on, and before any gl_accounts row lock: the
 * Default Accounts save, the COA import's role map, the migration import and
 * rollback, the template seed, the Opening Balance Equity auto-create, an
 * account deactivate / delete / reclassify, the bank-account deactivate, and
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

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the lock. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Another request held the company's role-write lock for longer than 5s. */
export class SystemRoleLockTimeoutError extends Error {
  readonly code = 'SYSTEM_ROLE_LOCK_TIMEOUT';
  constructor() {
    super('The chart of accounts is being changed by another request — retry in a moment.');
    this.name = 'SystemRoleLockTimeoutError';
  }
}

export async function lockSystemRoleWrites(companyId: string, q: SqlExec = sql): Promise<void> {
  const prev = (await q`SELECT current_setting('lock_timeout') AS v`) as { v?: unknown }[];
  try {
    await q`
      SELECT CASE WHEN set_config('lock_timeout', '5s', true) IS NOT NULL
        THEN pg_advisory_xact_lock(hashtextextended(${`default-accounts:${companyId}`}::TEXT, 0))::TEXT END`;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE) throw new SystemRoleLockTimeoutError();
    throw err;
  }
  await q`SELECT set_config('lock_timeout', ${String(prev[0]?.v ?? '0')}, true)`;
}
