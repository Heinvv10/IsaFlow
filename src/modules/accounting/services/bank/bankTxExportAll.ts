/**
 * Every posted bank statement line of a company in a date range, across all
 * its bank accounts — the all-accounts export on the Bank Transactions page.
 *
 * The rows are the page's own (TX_SELECT + mapTxRow), so the allocated
 * account and dimensions match what the screen shows. Posted feed rows only:
 * a pending feed row is not yet a statement line and a removed one never was.
 * The range is capped so one request cannot build an unbounded file in memory.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { BankTransaction } from '../../types/bank.types';
import { mapTxRow } from './bankTxRowMapper';
import { TX_SELECT } from './bankTxQueryFragments';

export const BANK_TX_EXPORT_MAX_DAYS = 366;

export async function getAllBankTransactionsForExport(
  companyId: string, fromDate: string, toDate: string,
): Promise<BankTransaction[]> {
  const rows = (await sql`${sql.unsafe(TX_SELECT)}
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.feed_state = 'posted'
      AND bt.transaction_date BETWEEN ${fromDate}::DATE AND ${toDate}::DATE
    ORDER BY ga.account_code, bt.transaction_date, bt.id`) as DbRow[];
  return rows.map(mapTxRow);
}
