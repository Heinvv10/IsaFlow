/**
 * The OTHER live line of the run row's journal — a transfer's auto-linked counterpart (bankTransferAutoLink), or any
 * second line matched to it — for the confidence gate's `undoRow` of a posting already HAND-REVERSED (WP2 row 5 round 2): no reversal
 * runs there, so nothing else frees it. Where the undo reverses (a standing journal), `reverseReconciledTransaction`
 * frees every other leg itself (WP2 row 10, transferLegReset) — as it does for the screen, MCP reverse_bank_allocation
 * and the batch / range reversals — one mechanism. Locked (id order, sessions first) and refused, as the run row's own
 * reconciliation skip, when a reconciliation holds it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockBankTransactionsInIdOrder } from './bankTxLock';
import { reconciliationLockOf, type LineLock } from './reconciledCash';

/**
 * Before the run row's own lock: the other live lines matched to the journal the row's line is matched to, unlocked,
 * so undoRow can lock them WITH the row in id order (#1494 rev: X then Y against a reverse from Y, which locks {Y, X}
 * in id order, deadlocked). Any allocation type — the same set reverseReconciledTransaction's leg reset judges.
 */
export async function peekCounterpartIds(companyId: string, txId: string): Promise<string[]> {
  return ((await sql`
    SELECT o.id::TEXT AS id FROM bank_transactions t
    JOIN gl_journal_lines tl ON tl.id = t.matched_journal_line_id AND tl.company_id = t.company_id
    JOIN gl_journal_lines ol ON ol.journal_entry_id = tl.journal_entry_id AND ol.company_id = t.company_id
    JOIN bank_transactions o ON o.matched_journal_line_id = ol.id AND o.company_id = t.company_id
    WHERE t.id = ${txId}::UUID AND t.company_id = ${companyId}::UUID AND o.id <> t.id
      AND o.status IN ('allocated', 'matched', 'reconciled')
  `) as DbRow[]).map((r) => String(r.id));
}

export async function lockTransferCounterparts(
  companyId: string, tx: DbRow, journalEntryId: string,
): Promise<{ ids: string[]; lock: LineLock | null }> {
  // Every allocation type (#1494 rev): a reconciled second line of ANY journal is refused by the reversal's leg reset
  // (WP2 row 10), so the undo's skip judges the same set.
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
