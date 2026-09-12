/**
 * The bulk-commit dedupe: drop every parsed statement line whose content hash
 * already exists on the account inside the file's date window. Extracted from
 * `pages/api/accounting/bank-transactions-bulk-commit.ts` to keep the route
 * under the 300-line cap; the hash and its known limitation are
 * `utils/bankTransactionHash.ts` (see bank/.claude.md, "Dedup is a CONTENT HASH").
 */

import { sql } from '@/lib/neon';
import { bankTransactionHash, type HashableTransaction } from '../../utils/bankTransactionHash';
import type { BankCsvParseResult } from '../../types/bank.types';

export async function dedupeParsedTransactions(companyId: string, bankAccountId: string,
  transactions: BankCsvParseResult['transactions']): Promise<{ dedupedTxs: BankCsvParseResult['transactions']; duplicateCount: number }> {
  if (transactions.length === 0) return { dedupedTxs: transactions, duplicateCount: 0 };
  const dates = transactions
    .map(t => t.transactionDate)
    .filter(d => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  if (!from || !to) return { dedupedTxs: transactions, duplicateCount: 0 };

  const existing = (await sql`
    SELECT transaction_date::text AS transaction_date, amount, description
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID
      AND bank_account_id = ${bankAccountId}::UUID
      AND transaction_date BETWEEN ${from} AND ${to}
  `) as Array<{ transaction_date: string; amount: string | number; description: string | null }>;

  const existingHashes = new Set<string>();
  for (const row of existing) {
    const hashable: HashableTransaction = {
      transactionDate: row.transaction_date,
      amount: Number(row.amount),
      description: row.description ?? '',
    };
    existingHashes.add(bankTransactionHash(hashable));
  }
  let duplicateCount = 0;
  const dedupedTxs = transactions.filter(tx => {
    const h = bankTransactionHash({
      transactionDate: tx.transactionDate,
      amount: tx.amount,
      description: tx.description ?? '',
    });
    if (existingHashes.has(h)) {
      duplicateCount++;
      return false;
    }
    return true;
  });
  return { dedupedTxs, duplicateCount };
}
