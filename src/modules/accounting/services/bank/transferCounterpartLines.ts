/**
 * The OTHER bank's line a transfer auto-linked (bankTransferAutoLink: status allocated, matched to the journal's other
 * bank leg), for an undo that reverses the transfer from ONE line — the confidence gate's `undoRow` (WP2 row 5 round 2).
 * The run tags only the line it posted, so undoing it reversed the journal and left the counterpart allocated to a
 * journal no longer on the books. Locked (id order, sessions first) BEFORE the reversal claims the journal — the
 * bank -> GL order — and refused, as the run row's own reconciliation skip, when a reconciliation holds it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockBankTransactionsInIdOrder } from './bankTxLock';
import { reconciliationLockOf, type LineLock } from './reconciledCash';

export async function lockTransferCounterparts(
  companyId: string, tx: DbRow, journalEntryId: string,
): Promise<{ ids: string[]; lock: LineLock | null }> {
  if (tx.allocation_type !== 'transfer') return { ids: [], lock: null };
  const found = (await sql`
    SELECT bt.id::TEXT AS id FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID AND jl.journal_entry_id = ${journalEntryId}::UUID
      AND bt.id <> ${String(tx.id)}::UUID AND bt.status IN ('allocated', 'matched', 'reconciled')
  `) as DbRow[];
  if (found.length === 0) return { ids: [], lock: null };
  const rows = await lockBankTransactionsInIdOrder(companyId, found.map((r) => String(r.id)));
  for (const row of rows) {
    const lock = await reconciliationLockOf(companyId, row);
    if (lock) return { ids: [], lock };
  }
  // Re-read under the lock: an unmatch that landed before it leaves nothing to free.
  return { ids: rows.filter((r) => ['allocated', 'matched'].includes(String(r.status)) && r.matched_journal_line_id)
    .map((r) => String(r.id)), lock: null };
}
