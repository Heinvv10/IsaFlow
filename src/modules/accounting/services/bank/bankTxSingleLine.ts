/** One bank line of the company, in the grid's row shape: the line a mention's link opens in the drawer (M14). */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { TX_SELECT } from './bankTxQueryFragments';
import { mapTxRow } from './bankTxRowMapper';
import { withJitOff } from '../gl/dimensions/boundedStatements';
import type { BankTransaction } from '../../types/bank.types';

export async function getBankTransactionById(companyId: string, id: string): Promise<BankTransaction | null> {
  // JIT off (withJitOff): TX_SELECT's plan estimate can cross the JIT thresholds, as on the Banking list (W8).
  const rows = (await withJitOff(() => sql`${sql.unsafe(TX_SELECT)}
    WHERE bt.id = ${id}::UUID AND bt.company_id = ${companyId}::UUID AND bt.feed_state <> 'removed'`)) as DbRow[];
  return rows[0] ? mapTxRow(rows[0]) : null;
}
