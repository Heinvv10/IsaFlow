/**
 * Row-lock helper for the bank-allocation write paths.
 *
 * `allocateTransaction`, `splitAllocateTransaction` and
 * `reverseReconciledTransaction` all read `bank_transactions.status`, refuse on
 * the wrong status, and then post a journal. Without a lock two concurrent
 * REQUESTS (a UI double-click, an agent retry carrying a fresh idempotency key)
 * both pass the status check and both post — one transaction, two journals.
 *
 * Since PR #264 every request runs inside a single transaction on the
 * AsyncLocalStorage-bound client, so `FOR UPDATE` taken here is held for the
 * rest of the request: the second request blocks on the row until the first
 * commits, then re-reads the now-`allocated` status and refuses.
 *
 * Write paths ONLY — never call this from a list/query service.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * Read one bank transaction for a company and hold a row lock on it until the
 * end of the surrounding transaction. Returns `null` when the row does not
 * exist or belongs to another tenant — callers keep their own NOT_FOUND wording.
 */
export async function lockBankTransactionForUpdate(
  companyId: string,
  bankTxId: string,
): Promise<DbRow | null> {
  const rows = (await sql`
    SELECT * FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE`) as DbRow[];
  return rows[0] ?? null;
}
