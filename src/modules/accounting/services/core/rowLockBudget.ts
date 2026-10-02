/**
 * ONE bounded wait for a row lock (D8 round 9, review rev-d8-9ecdfa549 finding 1).
 *
 * A `FOR UPDATE` with no `lock_timeout` waits as long as the holder holds: a
 * same-tenant request that keeps a journal row locked pins every request that
 * needs it on a pooled connection (the shape sec-d8-69e4fe48b F1 closed for
 * `lockChainHead` alone). Every row lock the D8 reversal flows take runs
 * through `withRowLockBudget`:
 *
 *   · the wait ends by a DEADLINE — 5 s from the call by default; a caller that
 *     takes several locks for one decision (`lockChainHead`'s passes) passes one
 *     deadline to all of them, so the total is bounded, not each pass;
 *   · it is set as a transaction-local `lock_timeout` (`set_config(.., true)`)
 *     and the caller's value is RESTORED afterwards on every path that leaves
 *     the transaction usable — never reset to DEFAULT, which silently unbounded
 *     whatever the caller had set;
 *   · a timeout is the caller's own typed, retryable error (`onTimeout`), which
 *     the routes answer 503 + Retry-After (`@/lib/apiDocumentLock`).
 *
 * Settings go through the request client directly, not `sql`, so a caller's
 * SQL sequence is unchanged. Outside a request transaction there is no client
 * and nothing to bound: `FOR UPDATE` there locks nothing beyond its statement,
 * and `fn` runs as before.
 */
import { als, assertTxUsable } from '@/lib/als';
import { log } from '@/lib/logger';

export const ROW_LOCK_BUDGET_MS = 5000;

/** Postgres `lock_not_available` — the `lock_timeout` elapsed. */
const LOCK_NOT_AVAILABLE = '55P03';

/** A row lock not acquired within its budget, where the caller has no lock-timeout class of its own. */
export class RowLockTimeoutError extends Error {
  readonly code = 'ROW_LOCK_TIMEOUT';
  constructor(what: string) {
    super(`${what} is being changed by another request — retry in a moment.`);
    this.name = 'RowLockTimeoutError';
  }
}

export interface RowLockBudgetOpts {
  /** Epoch ms the wait must end by. Default: now + ROW_LOCK_BUDGET_MS. */
  deadline?: number;
  /** What counts as the wait running out. Default: 55P03. */
  isTimeout?: (err: unknown) => boolean;
}

const isLockNotAvailable = (err: unknown) => (err as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE;
/** A Postgres error aborted the (sub)transaction: its rollback restores the setting, and a statement now would raise 25P02. */
const isPgError = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
};

export async function withRowLockBudget<T>(
  fn: () => Promise<T>,
  onTimeout: () => Error,
  opts: RowLockBudgetOpts = {},
): Promise<T> {
  const client = als.getStore()?.client;
  if (!client) return fn();
  assertTxUsable();
  const remaining = (opts.deadline ?? Date.now() + ROW_LOCK_BUDGET_MS) - Date.now();
  if (remaining <= 0) throw onTimeout();
  const current = await client.query("SELECT current_setting('lock_timeout') AS v");
  const previous = String(current?.rows?.[0]?.v ?? '0');
  await client.query("SELECT set_config('lock_timeout', $1, true)", [`${remaining}ms`]);
  const restore = () => client.query("SELECT set_config('lock_timeout', $1, true)", [previous]);
  let out: T;
  try {
    out = await fn();
  } catch (err) {
    if (!isPgError(err)) {
      // A refusal thrown by `fn` itself (the transaction is live): put the caller's value back, keep the refusal.
      await restore().catch((restoreErr: unknown) => {
        log.error('Failed to restore lock_timeout after a refused row lock', { error: restoreErr }, 'accounting');
      });
    }
    if ((opts.isTimeout ?? isLockNotAvailable)(err)) throw onTimeout();
    throw err;
  }
  await restore();
  return out;
}
