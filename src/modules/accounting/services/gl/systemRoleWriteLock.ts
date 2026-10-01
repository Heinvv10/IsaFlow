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
 * as a 500.
 *
 * THE RESIDUAL ORDERING CASE (decided 2026-10-01, do not "fix" it in the line
 * guards). The role lock taken first by every gl_accounts writer removes the
 * cycles the chart itself could make. One remains: an EARLIER statement of the
 * same transaction row-locked a role account WITHOUT the role lock — a
 * bill / PO / expense-claim line guard takes FOR SHARE on its account — and a
 * later statement of that transaction (an MCP batch) writes the chart. A save,
 * or another batch, can then hold the role lock and wait for that row while
 * this transaction waits for the role lock. The line guards run on every
 * document line, so an exclusive company lock there would serialise ordinary
 * document entry; instead the cycle is left to Postgres, which breaks it after
 * `deadlock_timeout` (1s), and the victim is told to retry.
 */
const RETRYABLE_LOCK_ERRORS = new Set(['55P03', '40P01']);
export const isRetryableLockError = (err: unknown): boolean =>
  RETRYABLE_LOCK_ERRORS.has(String((err as { code?: unknown } | null)?.code ?? ''));

/** What a caller is told. */
export const SYSTEM_ROLE_LOCK_TIMEOUT_MESSAGE = 'The chart of accounts is being changed by another request — retry in a moment.';

/**
 * Is this MCP tool result the role lock's timeout (or deadlock) refusal? The
 * tool threw it and the registry worded it, so the batch loop — which must not
 * make the calls behind it wait 5s each — can only know it by its text.
 */
export function isRoleLockRefusal(result: unknown): boolean {
  const r = result as { isError?: boolean; content?: { text?: string }[] } | null | undefined;
  return r?.isError === true && r.content?.[0]?.text === SYSTEM_ROLE_LOCK_TIMEOUT_MESSAGE;
}

/**
 * For a catch that reports a failure as text and carries on (a migration step's
 * `errors[]`): the error's text — unless it is a lock timeout or a deadlock,
 * which is thrown on. Reported as a row error on a 200, the steps before it
 * stayed written; thrown, the whole request rolls back and answers 503.
 */
export function textUnlessLockError(err: unknown): string {
  if (isRetryableLockError(err)) throw err;
  return err instanceof Error ? err.message : String(err);
}

/** Another request held the company's role-write lock for longer than 5s. */
export class SystemRoleLockTimeoutError extends Error {
  readonly code = 'SYSTEM_ROLE_LOCK_TIMEOUT';
  constructor() {
    super(SYSTEM_ROLE_LOCK_TIMEOUT_MESSAGE);
    this.name = 'SystemRoleLockTimeoutError';
  }
}

/**
 * Run `take` with every lock wait inside it bounded at 5s, restoring the
 * caller's own `lock_timeout` after. Used for the statements a role writer
 * runs WHILE IT HOLDS the role lock: an unbounded row wait there would hold the
 * company's role lock for as long as the row's holder runs, and every other
 * chart writer would time out behind it. A timeout (55P03) or a deadlock
 * (40P01) is rethrown as the typed, retryable refusal; the statement's
 * transaction or savepoint is aborted, so the caller must throw it on.
 */
export async function withBoundedLockWait<T>(q: SqlExec, take: () => PromiseLike<T>): Promise<T> {
  const prev = (await q`SELECT current_setting('lock_timeout') AS v`) as { v?: unknown }[];
  await q`SELECT set_config('lock_timeout', '5s', true)`;
  try {
    return await take();
  } catch (err) {
    if (isRetryableLockError(err)) throw new SystemRoleLockTimeoutError();
    throw err;
  } finally {
    // Later waits of the request must not inherit the 5s. After a database
    // error the transaction may be aborted: this statement then fails too, and
    // the rollback that must follow restores the setting.
    try {
      await q`SELECT set_config('lock_timeout', ${String(prev[0]?.v ?? '0')}, true)`;
    } catch { /* aborted transaction — restored by its rollback */ }
  }
}

/** `withBoundedLockWait` on the request's own connection, for a chart writer's row-locking statements. */
export const boundedRowWait = <T>(take: () => PromiseLike<T>): Promise<T> => withBoundedLockWait(sql, take);

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
