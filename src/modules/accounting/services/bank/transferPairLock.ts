/**
 * Serialise every writer of ONE bank-to-bank movement (audit 2026-11-15, WP2 row 6).
 *
 * Two statement lines of one movement (bank 1 -X and bank 2 +X) each allocated as a transfer to the other bank at the
 * same time both pass `assertNoDuplicateTransfer` — each reads before either commits — and two journals post for one
 * movement. The same race exists between a Banking > Transfers post and a statement allocation (the stated residual in
 * transferDuplicateGuard). Nothing in the schema can refuse it, so the writers queue on one transaction-scoped advisory
 * lock keyed on the company and the SORTED account pair (either direction, either leg, same key), taken BEFORE the
 * duplicate check and held to the end of the request: the second writer then reads the first one's committed journal.
 *
 * Lock order (bank/.claude.md): AFTER the bank line(s) a caller holds, BEFORE the journal-number lock the journal
 * INSERT trigger takes (857/858), so the pair key is never awaited by a holder of a later lock in the same request:
 * no request posts two transfer journals today (a bulk one would, once WP2 row 5 routes bulk bank contras here — it
 * must then take every pair first, in sorted order; see the table row). It is bounded 5 s, tighten-only like
 * `documentNumberLockBudget` and `bankAccountGuard` (a tighter caller value is kept, and the caller's value is put back),
 * and a wait that runs out is `RowLockTimeoutError`, which every route answers 503 + Retry-After.
 */
import { sql } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';
import { isLockNotAvailable } from '../core/lockContention';
import { RowLockTimeoutError, restoreLockTimeout } from '../core/rowLockBudget';

/** The key both legs (and the typed transfer) take: company + the two accounts in sorted order. */
export function transferPairKey(companyId: string, accountA: string, accountB: string): string {
  const [lo, hi] = [accountA.toLowerCase(), accountB.toLowerCase()].sort();
  return `bank_transfer_pair:${companyId.toLowerCase()}:${lo}:${hi}`;
}

export async function lockTransferPair(companyId: string, accountA: string, accountB: string): Promise<void> {
  const client = als.getStore()?.client;
  if (!client) return; // no request transaction: a transaction-scoped lock would outlive nothing
  assertTxUsable();
  const { rows } = await client.query<{ prev: string }>(
    `SELECT s.prev, set_config('lock_timeout', CASE WHEN s.prev::interval = interval '0'
       OR s.prev::interval > interval '5s' THEN '5s' ELSE s.prev END, true)
     FROM (SELECT current_setting('lock_timeout') AS prev) s`);
  let failure: unknown = null;
  try {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${transferPairKey(companyId, accountA, accountB)}, 0))`;
  } catch (err) {
    failure = err;
    if (isLockNotAvailable(err)) throw new RowLockTimeoutError('A transfer between these two bank accounts');
    throw err;
  } finally {
    await restoreLockTimeout(client, rows[0]!.prev, failure);
  }
}
