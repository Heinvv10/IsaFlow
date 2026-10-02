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

interface QueryClient { query: (text: string, params?: unknown[]) => Promise<unknown> }

/**
 * The `lock_timeout` in force, read before a lock helper sets its own, so it can put back exactly that
 * (D8 round 10). The pre-existing helpers reset to DEFAULT, which silently unbounded every later lock of
 * an enclosing `withRowLockBudget`.
 */
export async function currentLockTimeout(client: QueryClient): Promise<string> {
  const r = (await client.query("SELECT current_setting('lock_timeout') AS v")) as { rows?: { v?: unknown }[] } | undefined;
  return String(r?.rows?.[0]?.v ?? '0');
}

/**
 * Put `previous` back, for a helper's `finally`. Skipped after a Postgres error: the transaction (or
 * savepoint) is aborted, its rollback restores the setting, and a statement now would raise 25P02 in place
 * of the real error. A restore that fails after a non-Postgres refusal is logged; the refusal stands.
 */
export async function restoreLockTimeout(client: QueryClient, previous: string, failure: unknown = null): Promise<void> {
  if (isPgError(failure)) return;
  try {
    await client.query("SELECT set_config('lock_timeout', $1, true)", [previous]);
  } catch (restoreErr) {
    if (failure === null) throw restoreErr;
    log.error('Failed to restore lock_timeout after a refused row lock', { error: restoreErr }, 'accounting');
  }
}

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
  const previous = await currentLockTimeout(client);
  await client.query("SELECT set_config('lock_timeout', $1, true)", [`${remaining}ms`]);
  let failure: unknown = null;
  try {
    return await fn();
  } catch (err) {
    failure = err;
    if ((opts.isTimeout ?? isLockNotAvailable)(err)) throw onTimeout();
    throw err;
  } finally {
    await restoreLockTimeout(client, previous, failure);
  }
}

/**
 * A whole D8 flow's locking section under ONE budget (D8 round 10): every lock it takes — `FOR UPDATE` or the row
 * lock of a plain UPDATE — waits at most ROW_LOCK_BUDGET_MS, set once and restored once; nested helpers restore it
 * rather than reset it. A wait that runs out is `RowLockTimeoutError(what)`, 503 + Retry-After at the routes.
 */
export function underFlowLockBudget<T>(what: string, fn: () => Promise<T>): Promise<T> {
  return withRowLockBudget(fn, () => new RowLockTimeoutError(what));
}
