/**
 * The OTHER bank's line a transfer auto-linked (bankTransferAutoLink: status allocated, matched to the journal's other
 * bank leg), for the confidence gate's `undoRow` of a posting already HAND-REVERSED (WP2 row 5 round 2): no reversal
 * runs there, so nothing else frees it. Where the undo reverses (a standing journal), `reverseReconciledTransaction`
 * frees every other leg itself (WP2 row 10, transferLegReset) — as it does for the screen, MCP reverse_bank_allocation
 * and the batch / range reversals — one mechanism. Locked (id order, sessions first) and refused, as the run row's own
 * reconciliation skip, when a reconciliation holds it.
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
