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

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds the row longer than the 5s `lock_timeout`.
 * The bank API routes return a caught service error's message as a 400, so this
 * wording is what the caller reads — it has to say "retry".
 */
export class BankTransactionLockTimeoutError extends Error {
  readonly code = 'BANK_TX_LOCK_TIMEOUT';
  constructor(bankTxId: string) {
    super(`Bank transaction ${bankTxId} is being allocated by another request — retry in a moment.`);
    this.name = 'BankTransactionLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
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
 * The 5s `lock_timeout` is `SET LOCAL` on the request client, so it holds for
 * the remainder of the request transaction rather than just this statement —
 * deliberately: once one lock in a request is worth bounding, so is every lock
 * that follows it. 5s is long enough to absorb a peer's normal allocation and
 * short enough that a wedged peer surfaces as a retryable error instead of
 * pinning the connection.
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
  // unchanged.
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = (await sql`
      SELECT * FROM bank_transactions
      WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
      FOR UPDATE`) as DbRow[];
    return rows[0] ?? null;
  } catch (err) {
    if (isLockTimeout(err)) throw new BankTransactionLockTimeoutError(bankTxId);
    throw err;
  }
}
