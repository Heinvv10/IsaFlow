/**
 * Row-lock helper for the bank-transaction WRITE paths.
 *
 * Every path that reads `bank_transactions.status`, refuses on the wrong
 * status, and then posts or rewrites the row has a check-then-act window. Two
 * concurrent REQUESTS (a UI double-click, an agent retry carrying a fresh
 * idempotency key) both pass the check and both act — one transaction, two
 * journals, or a status write that clobbers a freshly committed allocation and
 * orphans its journal.
 *
 * Since PR #264 every request runs inside a single transaction on the
 * AsyncLocalStorage-bound client, so `FOR UPDATE` taken here is held for the
 * rest of the request: the second request blocks on the row until the first
 * commits, then re-reads the settled status and refuses.
 *
 * Write paths ONLY — never call this from a list/query service.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';
import { isLockContention } from '../core/lockContention';
import { currentLockTimeout, restoreLockTimeout } from '../core/rowLockBudget';
import { shareLockStampedSessions, stampHeld } from './reconciliationSessionLock';

/**
 * Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row.
 * Kept local to the table-lock probe below: `isLockContention` is what the
 * WRITE path classifies on, and it covers the deadlock SQLSTATE too.
 */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds the row longer than the 5s `lock_timeout`,
 * or when Postgres breaks a deadlock (`40P01`) by choosing this transaction as
 * the victim — `isLockContention` covers both. They are one answer to a caller:
 * nothing was written, the row was never acquired, and retrying is the remedy.
 * The name is kept because routes match on the `BANK_TX_LOCK_TIMEOUT` code.
 * The bank API routes surface a caught service error's message to the caller,
 * and since r13 they all surface it as a 409 — the narrow routes via
 * `isBankTransactionLockTimeout`, the blanket-catch action routes via
 * `core/retryableContention` — so this wording is what the user reads. It has
 * to say "retry".
 */
export class BankTransactionLockTimeoutError extends Error {
  readonly code = 'BANK_TX_LOCK_TIMEOUT';
  constructor(bankTxId: string) {
    super(`Bank transaction ${bankTxId} is being allocated by another request — retry in a moment.`);
    this.name = 'BankTransactionLockTimeoutError';
  }
}

/**
 * Structural, not `instanceof`: a route deciding a status code on this must not
 * be defeated by module mocking or by two bundled copies of this file. The
 * condition is RETRYABLE and nothing has been written — the row was never
 * acquired — so a caller may answer it with a 409.
 */
export function isBankTransactionLockTimeout(err: unknown): err is BankTransactionLockTimeoutError {
  return err instanceof Error
    && (err as { code?: unknown }).code === 'BANK_TX_LOCK_TIMEOUT';
}

/**
 * Read one bank transaction for a company and hold a row lock on it until the
 * end of the surrounding transaction. Returns `null` when the row does not
 * exist or belongs to another tenant — callers keep their own NOT_FOUND wording.
 *
 * Throws if no request transaction is in flight: outside one, every statement is
 * its own implicit transaction, so `FOR UPDATE` releases the instant the SELECT
 * returns and the caller believes it is serialised when it is not. A loud
 * failure beats a lock that silently does nothing.
 *
 * The 5s `lock_timeout` is re-issued on EVERY call, not memoised per request.
 * `SET LOCAL` is subtransaction-aware: `ROLLBACK TO SAVEPOINT` restores the
 * previous value, which is `0` — no timeout at all. Since every MCP tool call
 * and every `withTransaction` runs in a savepoint that rolls back on failure,
 * a "set it once per connection" cache would leave later locks waiting forever
 * precisely on the paths where contention is likeliest. One extra round-trip on
 * an already-open connection is the cheaper mistake. (Verified against pg:
 * SET LOCAL '5s' inside a savepoint reads back as `0` after ROLLBACK TO.)
 *
 * 5s is long enough to absorb a peer's normal allocation and short enough that
 * a wedged peer surfaces as a retryable error instead of pinning the connection.
 */
export async function lockBankTransactionForUpdate(
  companyId: string,
  bankTxId: string,
): Promise<DbRow | null> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'lockBankTransactionForUpdate requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }

  // Issued on the request client directly, not through `sql`: it is a
  // transaction setting rather than a tenant query, it carries no parameters,
  // and keeping it off the query path leaves callers' SQL call sequence
  // unchanged. Re-issued every call — see the note above on savepoint rollback.
  //
  // Because it bypasses `sql`, it also bypasses that path's usability check —
  // so a connection aborted by an earlier failed savepoint rollback would
  // answer this raw query with a bare 25P02 BEFORE the guarded SELECT below is
  // reached, handing the caller the opaque error the check exists to replace.
  assertTxUsable();
  const previousLockTimeout = await currentLockTimeout(client);
  await client.query("SET LOCAL lock_timeout = '5s'");
  let failure: unknown = null;
  try {
    // D12: the session the line is stamped with, FOR SHARE, BEFORE the line — session row -> bank line is the lock
    // order (`reconciliationSessionLock.ts`), and it is what serialises a completion or reopen against this writer.
    // Held past the budget: the same retryable timeout as a held line. A stamp that moved between that peek and the
    // line lock names a session that can no longer be taken in order: refused as that contention too.
    const sessions = await shareLockStampedSessions(companyId, [bankTxId]);
    // `SELECT *` carries feed_state, which assertFeedPosted/feedStateOf require — never narrow it.
    const rows = (await sql`
      SELECT * FROM bank_transactions
      WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
      FOR UPDATE`) as DbRow[];
    const row = rows[0] ?? null;
    if (row && !stampHeld(row, sessions)) throw new BankTransactionLockTimeoutError(bankTxId);
    return row;
  } catch (err) {
    failure = err;
    // Classified with `isLockContention`, not the 55P03 check alone: a DEADLOCK
    // (40P01) is the same answer to the caller — the row was never acquired,
    // nothing was written, retrying is the remedy — and left unmapped it
    // reaches `withAuth` as a 500 on the money path.
    //
    // A 55P03 here has the same two readings the match UPDATE has — a peer
    // holding the row, or DDL holding the TABLE — and this branch reports both
    // as the first: the message says "being allocated by another request" and
    // `autoMatchTransactions` counts it in `skippedRaced`. `tableLockUnavailable`
    // is deliberately NOT consulted, because it cannot run here: this SELECT is
    // outside a savepoint, so its 55P03 aborts the transaction and the probe's
    // LOCK TABLE comes back 25P02 "current transaction is aborted", masking the
    // real error instead of classifying it (verified against pg on the schema
    // fixture). Discriminating at this call site means wrapping the SELECT in
    // its own savepoint on every bank write path — deferred, and recorded in
    // docs/audits/remediation/K-140/fix.md.
    //
    // The window is narrower than the UPDATE's. `FOR UPDATE` takes ROW SHARE,
    // which does not conflict with the SHARE a non-CONCURRENTLY `CREATE INDEX`
    // holds, so migration 657 — the case that motivated the match fix — is
    // GRANTED here rather than refused. Only an EXCLUSIVE or ACCESS EXCLUSIVE
    // holder (`ALTER TABLE`, `VACUUM FULL`, `TRUNCATE`) reaches this branch, and
    // the wording it raises is at least retryable in either reading.
    if (isLockContention(err)) throw new BankTransactionLockTimeoutError(bankTxId);
    throw err;
  } finally {
    await restoreLockTimeout(client, previousLockTimeout, failure);
  }
}

/**
 * Lock several bank lines in ONE order — ascending id, the order `ORDER BY bt.id` gives — and return the rows found,
 * in that order. Every flow that takes more than one line goes through here (D8 round 11, rev-d8-c553cc0f8 F2): the
 * MCP void took the root journal's line and then the chain's in a second pass, the HTTP void took both in one id
 * pass, and the pair deadlocked whenever the head's line had the lower id.
 */
export async function lockBankTransactionsInIdOrder(companyId: string, ids: readonly string[]): Promise<DbRow[]> {
  const rows: DbRow[] = [];
  const sorted = [...new Set(ids.map((i) => i.toLowerCase()))].sort();
  // D12: every session the lines are stamped with, FOR SHARE in id order, BEFORE the first line — so no session is
  // taken after a line of this set is held. Each line's own lock below re-takes its session (already held).
  if (sorted.length > 1) {
    await withBankLockBudget(() => shareLockStampedSessions(companyId, sorted)).catch((err: unknown) => {
      throw isLockContention(err) ? new BankTransactionLockTimeoutError(sorted[0]!) : err;
    });
  }
  for (const id of sorted) {
    const row = await lockBankTransactionForUpdate(companyId, id);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Run `fn` under the same 5s `lock_timeout`, for a WRITE whose own wait must be
 * bounded: `matchTransaction`'s UPDATE waits on `uq_bank_tx_matched_line`
 * behind a peer's uncommitted binding. It used to inherit the budget
 * `lockBankTransactionForUpdate` left behind; that helper now restores the
 * caller's value, and the inherited wait became unbounded — a slow peer pinned
 * the request instead of answering LINE_CLAIMED.
 *
 * Call it INSIDE a savepoint. A timeout is then undone by ROLLBACK TO, which
 * restores the previous value too; on success the caller's value is restored
 * here (D8 round 10: not DEFAULT), so the budget ends with the write it was set for.
 */
export async function withBankLockBudget<T>(fn: () => Promise<T>): Promise<T> {
  const client = als.getStore()?.client;
  if (!client) throw new Error('withBankLockBudget requires a request transaction (withAuth / als.run).');
  assertTxUsable();
  const previousLockTimeout = await currentLockTimeout(client);
  await client.query("SET LOCAL lock_timeout = '5s'");
  let failure: unknown = null;
  try {
    return await fn();
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    await restoreLockTimeout(client, previousLockTimeout, failure);
  }
}

/** Is this the `lock_timeout` firing, on any statement in the request? */
export function isLockNotAvailable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE;
}

/**
 * Raised when the match could not be attempted because `bank_transactions`
 * itself was locked — DDL, `VACUUM FULL`, or migration 657's own
 * `CREATE UNIQUE INDEX`, which holds SHARE on the table for the length of the
 * build. Nothing is known about the journal line, so the wording claims
 * nothing about it. Retryable: the caller should try again, not reverse
 * anything.
 */
export class BankMatchUnavailableError extends Error {
  readonly code = 'BANK_MATCH_UNAVAILABLE';
  constructor(bankTxId: string) {
    super(`Bank transaction ${bankTxId} could not be matched right now — retry in a moment.`);
    this.name = 'BankMatchUnavailableError';
  }
}

/** `withSavepoint` caps names at 31 characters; this one is 24. */
const MATCH_LOCK_PROBE_SAVEPOINT = 'bank_tx_match_lock_probe';

/**
 * Did the failed UPDATE wait on the TABLE, or on the row?
 *
 * The match UPDATE runs under `withBankLockBudget`'s 5s `lock_timeout`, which
 * bounds EVERY lock wait that statement takes — not only the row and index
 * waits. So a raw 55P03 out of the match UPDATE has two readings: a peer
 * holding the journal line's index entry past 5s (genuine contention), or a
 * relation-level lock held by DDL (infrastructure). Reported as one, an index
 * build tells every user mid-deploy that their line is "already matched to
 * another bank transaction" — a specific claim that is false.
 *
 * `ROW EXCLUSIVE` is the mode the UPDATE itself takes, so asking for it NOWAIT
 * separates the two: it conflicts with SHARE / EXCLUSIVE / ACCESS EXCLUSIVE —
 * every lock a DDL statement takes — and with nothing a concurrent writer
 * holds. Granted means the table was free and the wait was on the row; refused
 * means the table is not.
 *
 * Runs after the write savepoint has rolled back, so the connection is usable,
 * and under its own savepoint so a refusal does not poison the request.
 */
export async function tableLockUnavailable(): Promise<boolean> {
  try {
    await withSavepoint(MATCH_LOCK_PROBE_SAVEPOINT, async (): Promise<void> => {
      await sql`LOCK TABLE bank_transactions IN ROW EXCLUSIVE MODE NOWAIT`;
    });
    return false;
  } catch (probeErr) {
    if (isLockNotAvailable(probeErr)) return true;
    throw probeErr;
  }
}
