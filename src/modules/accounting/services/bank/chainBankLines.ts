/**
 * The statement lines matched to ANY journal of a document journal's reversal chain — the root O, a middle reversal,
 * or the head (D8 round 12). One finder for every flow that takes a payment journal out of the ledger: HTTP void,
 * receipt cancel and batch reversal (`ap/paymentJournalReversal`) and the MCP void (`core/paymentVoidService`).
 * They looked at different sets — the root and head only, or the whole chain — so a line matched to a middle
 * reversal stayed 'matched' after the HTTP void took the chain out of the ledger, against cash the GL no longer holds.
 *
 * Walked down `reversal_of_id` from the root with the cycle guard of shared/journalChainHead (depth 64). Every status,
 * as the HTTP void read them: the caller locks each (`bankTxLock.lockBankTransactionsInIdOrder`), refuses reconciled
 * cash and frees the rest. Ascending id, the one lock order.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export async function findChainBankLines(companyId: string, rootId: string): Promise<string[]> {
  const rows = (await sql`
    WITH RECURSIVE walk AS (
      SELECT id, 1 AS depth, ARRAY[id] AS seen, false AS looped
      FROM gl_journal_entries WHERE id = ${rootId}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT j.id, walk.depth + 1, walk.seen || j.id, j.id = ANY(walk.seen)
      FROM gl_journal_entries j JOIN walk ON j.reversal_of_id = walk.id
      WHERE j.company_id = ${companyId}::UUID AND NOT walk.looped AND walk.depth < 64
    )
    SELECT DISTINCT bt.id
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
    WHERE bt.company_id = ${companyId}::UUID
      AND jl.journal_entry_id IN (SELECT id FROM walk)
    ORDER BY bt.id`) as DbRow[];
  return rows.map((r) => String(r.id));
}
