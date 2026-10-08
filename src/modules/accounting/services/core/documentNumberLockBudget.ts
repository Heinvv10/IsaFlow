/**
 * The 5 s lock budget of reserveNextDocumentNumber's counter-row wait (companySettingsService).
 *
 * Tighten-only, as migrations 858/864: 5 s when the caller's lock_timeout is 0 (unbounded) or looser, a tighter one
 * kept; and it is the CALLER'S value that is put back afterwards — DEFAULT would unbound a request that set one.
 * Two reservations in flight on one connection (Promise.all) share one budget: the first in reads the caller's value,
 * the last out puts it back (brk-nrfd LOW-3: each restoring what it read left the second's 5 s behind).
 */
import type { PoolClient } from 'pg';

export interface NumberLockBudget {
  /** Puts the caller's lock_timeout back when this is the last reservation out. Only on a usable transaction. */
  restore: () => Promise<void>;
  /** Leaves without a statement (an aborted transaction's rollback restores the setting). Idempotent. */
  leave: () => void;
}

export const NO_BUDGET: NumberLockBudget = { restore: async () => undefined, leave: () => undefined };

const inFlight = new WeakMap<object, { depth: number; prev: string }>();

export async function enterNumberLockBudget(client: Pick<PoolClient, 'query'>): Promise<NumberLockBudget> {
  let held = inFlight.get(client);
  if (!held) {
    const { rows } = await client.query<{ prev: string }>(
      `SELECT s.prev, set_config('lock_timeout', CASE WHEN s.prev::interval = interval '0'
         OR s.prev::interval > interval '5s' THEN '5s' ELSE s.prev END, true)
       FROM (SELECT current_setting('lock_timeout') AS prev) s`);
    // Another reservation may have entered while this read was queued behind it: it read first.
    held = inFlight.get(client) ?? { depth: 0, prev: rows[0]!.prev };
    inFlight.set(client, held);
  }
  held.depth += 1;
  const budget = held;
  let left = false;
  const exit = (): boolean => {
    if (left) return false;
    left = true;
    budget.depth -= 1;
    if (budget.depth > 0) return false;
    inFlight.delete(client);
    return true;
  };
  return {
    restore: async () => {
      if (exit()) await client.query(`SELECT set_config('lock_timeout', $1, true)`, [budget.prev]);
    },
    leave: () => { exit(); },
  };
}
