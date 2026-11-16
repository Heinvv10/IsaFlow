/**
 * A journal a LIVE bank line still books may not be reversed past that line (follow-up to the bank audit, 2026-11-16).
 *
 * Reversed from Journal Entries or MCP `reverse_journal_entry` (or soft-deleted, re-run by the migration wizard, a pay
 * run's journal reversed), the journal's statement line stayed `allocated` / `matched` against a journal no longer on
 * the books: its cards and tiles counted cash the ledger had taken back, and the reconciliation read it as matched. The
 * bank line's own undo (Banking → the line → Undo / Reverse) reverses the journal AND resets the line in one act, so
 * every other path refuses — before the reversal writes its contra (under the claim, which it releases).
 *
 * A COMPLETED reconciliation's line is D12's 409 first (`refuseReversingCompletedCash`). A provisional's own line
 * (`provisional_je_id`, D10) is not this rule's: a provisional reversed in the GL is the "dead provisional" state D10
 * frees on the line's undo.
 */
import { fmtDate } from '@/lib/fmtDate';
import { formatMoney } from '@/lib/money/formatMoney';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export class JournalHasLiveBankLineError extends Error {
  readonly code = 'JOURNAL_HAS_LIVE_BANK_LINE';
  constructor(readonly bankTransactionId: string, line: string, status: string) {
    super(`This journal books the bank line ${line}, which is still ${status} to it. Undo it from Bank Transactions `
      + '(the line\'s Undo or Reverse): that reverses the journal and resets the line together.'
      + (status === 'matched' ? ' To keep the journal, unmatch the line there instead, then reverse the journal.' : ''));
    this.name = 'JournalHasLiveBankLineError';
  }
}

export function isJournalHasLiveBankLine(err: unknown): err is JournalHasLiveBankLineError {
  return err instanceof Error && (err as { code?: unknown }).code === 'JOURNAL_HAS_LIVE_BANK_LINE';
}

const LIVE = new Set(['allocated', 'matched', 'reconciled']);

/**
 * The live statement lines (allocated / matched / reconciled, a matched line, not a provisional's own) whose movement
 * reversing `headId` takes out of the ledger: matched to the head, or to an entry an EVEN number of steps up from it
 * (a re-reversal books the original's direction again). One matched an ODD number of steps up (the original under a
 * legacy hand reversal, re-reversed now) gets its cash BACK. `among`: only these ids. Ascending id.
 */
export async function liveLinesLosingCash(companyId: string, headId: string, among?: readonly string[]): Promise<string[]> {
  return ((await sql`
    WITH RECURSIVE up AS (
      SELECT id, reversal_of_id, 0 AS dist, ARRAY[id] AS path
      FROM gl_journal_entries WHERE id = ${headId}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT p.id, p.reversal_of_id, up.dist + 1, up.path || p.id
      FROM gl_journal_entries p JOIN up ON p.id = up.reversal_of_id
      WHERE p.company_id = ${companyId}::UUID AND NOT p.id = ANY(up.path) AND cardinality(up.path) < 64
    )
    SELECT DISTINCT bt.id::TEXT AS id
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    JOIN up ON up.id = jl.journal_entry_id
    WHERE bt.company_id = ${companyId}::UUID AND up.dist % 2 = 0
      AND bt.status IN ('allocated', 'matched', 'reconciled') AND bt.provisional_je_id IS NULL
      AND (${among === undefined}::BOOLEAN OR bt.id = ANY(${[...(among ?? [])]}::UUID[]))
    ORDER BY 1`) as DbRow[]).map((r) => String(r.id));
}

/**
 * The first live line among the chain's cash lines (as read by refuseReversingCompletedCash / the GL entrance) whose
 * movement THIS reversal takes out of the ledger (`liveLinesLosingCash`), refused by name. `journalEntryId` is the entry
 * being reversed — the chain's head (an already-reversed entry is refused before any write). A reversal that gives a
 * line its cash back repairs it, and passes.
 */
export async function refuseLiveBankLines(companyId: string, journalEntryId: string, rows: readonly DbRow[]): Promise<void> {
  const live = rows.filter((r) => r.matched_journal_line_id && !r.provisional_je_id && LIVE.has(String(r.status)));
  if (live.length === 0) return;
  const takenOut = new Set(await liveLinesLosingCash(companyId, journalEntryId, live.map((r) => String(r.id))));
  const first = live.filter((r) => takenOut.has(String(r.id))).sort((a, b) => String(a.id) < String(b.id) ? -1 : 1)[0];
  if (!first) return;
  const label = `${fmtDate(first.transaction_date)} ${formatMoney(Number(first.amount))}`
    + `${first.description ? ` "${String(first.description)}"` : ''}`;
  throw new JournalHasLiveBankLineError(String(first.id), label, String(first.status));
}
