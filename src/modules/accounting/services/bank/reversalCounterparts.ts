/**
 * The MCP batch and range reversals (reverse_bank_allocation_batch, reverse_allocations) and a transfer's OTHER leg —
 * the line the transfer auto-linked outside the batch / range, which reverseReconciledTransaction resets with each line
 * (WP2 row 10, transferLegReset). Asked of the whole call BEFORE its first reversal (#1494 follow-ups M1 + brk):
 *
 *  - `counterpartRefusal` (read-only, so the range's dry run gives the same answer as the live call): a counterpart a
 *    reconciliation holds refuses the call before any write, where it used to fail at that line mid-call;
 *  - `preLockReversalLines`: every line and every counterpart locked in ONE id order (sessions first), so a single
 *    reverse of a counterpart (which locks {line, leg} in id order) cannot cross the call's per-line locks.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockBankTransactionsInIdOrder } from './bankTxLock';
import { reconciliationLockOf, refuseLockedCash } from './reconciledCash';
import { OTHER_LEG } from './transferLegReset';

/** The other live lines matched to the journals `lineIds` are matched to, outside `lineIds`. Unlocked; ascending id. */
export async function counterpartRows(companyId: string, lineIds: readonly string[]): Promise<DbRow[]> {
  if (lineIds.length === 0) return [];
  return (await sql`
    SELECT DISTINCT o.id::TEXT AS id, o.status, o.reconciliation_id
    FROM bank_transactions t
    JOIN gl_journal_lines tl ON tl.id = t.matched_journal_line_id AND tl.company_id = t.company_id
    JOIN gl_journal_lines ol ON ol.journal_entry_id = tl.journal_entry_id AND ol.company_id = t.company_id
    JOIN bank_transactions o ON o.matched_journal_line_id = ol.id AND o.company_id = t.company_id
    WHERE t.company_id = ${companyId}::UUID AND t.id = ANY(${[...lineIds]}::UUID[])
      AND NOT o.id = ANY(${[...lineIds]}::UUID[]) AND o.status IN ('allocated', 'matched', 'reconciled')
    ORDER BY 1
  `) as DbRow[];
}

/** The refusal the call would meet at a counterpart a reconciliation holds, or null. Read-only. */
export async function counterpartRefusal(companyId: string, lineIds: readonly string[]): Promise<string | null> {
  for (const leg of await counterpartRows(companyId, lineIds)) {
    try {
      refuseLockedCash(await reconciliationLockOf(companyId, leg), OTHER_LEG);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return null;
}

/** Before the first reversal: the lines and their counterparts, locked together in id order. */
export async function preLockReversalLines(companyId: string, lineIds: readonly string[]): Promise<void> {
  const legs = await counterpartRows(companyId, lineIds);
  await lockBankTransactionsInIdOrder(companyId, [...lineIds, ...legs.map((l) => String(l.id))]);
}
