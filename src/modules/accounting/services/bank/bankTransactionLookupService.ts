/**
 * PRD-11 §5 — resolve a bank transaction from the reference printed on the
 * statement.
 *
 * An agent transcribing a bank statement holds `bank_reference`, not a UUID.
 * Without this it has to list every transaction on the account and match by
 * hand — the "fetch everything first" step PRD-11 exists to remove.
 *
 * The match is EXACT (after trimming both sides). A prefix/LIKE match would
 * happily resolve "INV-1" onto "INV-10" and post the journal against the wrong
 * row; `bank_reference` is also the import dedup key, so exactness is the
 * property the rest of the module already relies on.
 */

import { sql, fmtDate } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** Enough for the caller to disambiguate; never the whole row (no leaking
 *  columns the MCP surface does not otherwise expose). */
export interface BankTransactionRefMatch {
  id: string;
  transactionDate: string;
  amount: number;
  description: string | null;
}

/**
 * Candidates carrying `bankReference` in `companyId`, oldest first.
 *
 * Bounded: an ambiguity message is rendered into a tool result, and a
 * pathological statement that repeats one reference hundreds of times must not
 * produce an unbounded payload. Anything past the cap is still ambiguous, which
 * is the only thing the caller acts on.
 */
const MAX_CANDIDATES = 25;

export async function findBankTransactionsByReference(
  companyId: string,
  bankReference: string,
  bankAccountId?: string,
): Promise<BankTransactionRefMatch[]> {
  const ref = bankReference.trim();
  // A blank reference would match every row whose bank_reference is blank —
  // resolve nothing rather than resolve arbitrarily.
  if (!ref) return [];

  const rows = (bankAccountId
    ? await sql`
        SELECT id, transaction_date, amount, description
        FROM bank_transactions
        WHERE company_id = ${companyId}::UUID
          AND btrim(bank_reference) = ${ref}
          AND bank_account_id = ${bankAccountId}::UUID
        ORDER BY transaction_date ASC, id ASC
        LIMIT ${MAX_CANDIDATES}`
    : await sql`
        SELECT id, transaction_date, amount, description
        FROM bank_transactions
        WHERE company_id = ${companyId}::UUID
          AND btrim(bank_reference) = ${ref}
        ORDER BY transaction_date ASC, id ASC
        LIMIT ${MAX_CANDIDATES}`) as DbRow[];

  return rows.map((row) => ({
    id: String(row.id),
    // fmtDate, not toISOString(): pg returns the DATE at local midnight and
    // UTC rendering rolls it back a day on the UTC+2 box.
    transactionDate: fmtDate(row.transaction_date),
    amount: Number(row.amount),
    description: row.description === null || row.description === undefined
      ? null
      : String(row.description),
  }));
}

/**
 * The transaction's current status, or `null` when it does not exist in this
 * company (another tenant's row reads identically to a missing one).
 *
 * Exists so the MCP allocate/reverse tools can refuse an unallocatable row
 * BEFORE calling the service. The services raise the same refusals themselves,
 * but by then the tool cannot tell a pre-write refusal from a failure that
 * struck after a journal was already posted — and the two need opposite
 * handling: a refusal is reported, a mid-write failure must be rethrown so the
 * registry's savepoint unwinds it.
 */
export async function getBankTransactionStatus(
  companyId: string,
  bankTxId: string,
): Promise<string | null> {
  const rows = (await sql`
    SELECT status FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const status = rows[0]?.status;
  return status === null || status === undefined ? null : String(status);
}
