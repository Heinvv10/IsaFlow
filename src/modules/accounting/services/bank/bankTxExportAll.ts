/**
 * Every posted bank statement line of a company in a date range, across all
 * its bank accounts — the all-accounts export on the Bank Transactions page.
 *
 * The rows are the page's own (TX_SELECT + mapTxRow), so the allocated
 * account and dimensions match what the screen shows. Posted feed rows only,
 * unlike the screen's queue (which also lists pending rows read-only): a
 * pending feed row has not posted at the bank yet and can still change or
 * vanish, so it is not a statement line to export.
 *
 * Bounded twice: the route caps the range at BANK_TX_EXPORT_MAX_DAYS and asks
 * for at most `limit` rows (BANK_TX_EXPORT_MAX_ROWS + 1, so it can tell a
 * range that is too big from one that is exactly full).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { BankTransaction } from '../../types/bank.types';
import { mapTxRow } from './bankTxRowMapper';
import { TX_SELECT } from './bankTxQueryFragments';

export const BANK_TX_EXPORT_MAX_DAYS = 366;
export const BANK_TX_EXPORT_MAX_ROWS = 50_000;

export async function getAllBankTransactionsForExport(
  companyId: string, fromDate: string, toDate: string, limit: number,
): Promise<BankTransaction[]> {
  const rows = (await sql`${sql.unsafe(TX_SELECT)}
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.feed_state = 'posted'
      AND bt.transaction_date BETWEEN ${fromDate}::DATE AND ${toDate}::DATE
    ORDER BY ga.account_code, bt.transaction_date, bt.id
    LIMIT ${limit}::INT`) as DbRow[];
  return rows.map(mapTxRow);
}
