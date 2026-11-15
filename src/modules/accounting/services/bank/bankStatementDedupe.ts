/**
 * The statement imports' dedup read: which lines of a parsed statement this bank account already holds.
 *
 * One copy for the statement upload (`bank-transactions-bulk-commit`), the agent import
 * (`bankStatementImportService`) and the classified worksheet import — each carried its own until WP2-2, and the
 * classified one keyed on the amount's JS spelling against NUMERIC::text ('2400.1' vs '2400.10'), so it never found a
 * duplicate. The hash is `bankTransactionHash` over (date, amount, description): Postgres-rounded amount, normalised
 * description, no balance (`bank_transactions` has none). The OCR commit keeps its own fuzzy fingerprint
 * (`bankStatementDedupHelpers`).
 *
 * A caller that INSERTs what this reports as new must hold `lockBankAccountIngest` (./bankIngestLock) for the same
 * account BEFORE calling it: the read and the insert are otherwise a check-then-insert race between two imports.
 */
import { sql } from '@/lib/neon';
import { bankTransactionHash } from '../../utils/bankTransactionHash';

export interface StatementLine { transactionDate: string; amount: number | string; description?: string | null }

export function statementLineHash(line: StatementLine): string {
  return bankTransactionHash({
    transactionDate: line.transactionDate,
    amount: Number(line.amount),
    description: line.description ?? '',
  });
}

/** Hashes of the lines already on this account inside [from, to]. */
export async function existingStatementHashes(
  companyId: string,
  bankAccountId: string,
  range: { from: string; to: string },
): Promise<Set<string>> {
  const rows = (await sql`
    SELECT transaction_date::text AS transaction_date, amount, description
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID
      AND bank_account_id = ${bankAccountId}::UUID
      AND transaction_date BETWEEN ${range.from}::DATE AND ${range.to}::DATE
      -- A row the bank removed never posted; it must not claim a real line's hash.
      AND feed_state <> 'removed'
  `) as Array<{ transaction_date: string; amount: string | number; description: string | null }>;
  return new Set(rows.map((row) => statementLineHash({
    transactionDate: row.transaction_date, amount: row.amount, description: row.description,
  })));
}
