/**
 * How a journal stands NOW, by its reversal chain rather than its flags.
 * Shared by the auto-post undo (is the posting still on the books?) and the
 * hand-offset check (is that offsetting journal still on the books?).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * `none`: nothing reverses the journal. `live`: a reversal stands, so the
 * posting is off the books. `reReversed`: the reversal was itself reversed,
 * so the ORIGINAL posting is back on the books.
 */
export type ReversalState = 'none' | 'live' | 'reReversed';

/**
 * `reversed_at` on the original cannot answer it. Reversing a contra is an
 * ordinary permitted operation — `reverseJournalEntry` refuses only an entry
 * that is not posted or already reversed, and a contra is posted with
 * `reversed_at` NULL — and it does not clear the original's `reversed_at`. So
 * original + contra + contra-of-contra nets back to the ORIGINAL posting while
 * the original still reads "reversed", and reading the flag alone let the run
 * be marked undone with the money still on the expense and the bank account.
 *
 * Walk the chain instead. Each POSTED contra flips the sign, so an odd number
 * of them means the posting is off the books and an even number means it is
 * still on them. `ux_gl_je_reversal_of` (migration 619) is unique on
 * (company_id, reversal_of_id), so the chain is linear; the depth cap only
 * bounds a cycle that constraint should already make impossible.
 */
export async function journalReversalState(companyId: string, journalEntryId: string): Promise<ReversalState> {
  const rows = (await sql`
    WITH RECURSIVE reversal_chain AS (
      SELECT id, 0 AS depth FROM gl_journal_entries
      WHERE id = ${journalEntryId}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT c.id, rc.depth + 1
      FROM gl_journal_entries c
      JOIN reversal_chain rc ON c.reversal_of_id = rc.id
      WHERE c.company_id = ${companyId}::UUID AND c.status = 'posted' AND rc.depth < 20
    )
    SELECT MAX(depth) AS depth FROM reversal_chain
  `) as DbRow[];
  const depth = Number(rows[0]?.depth ?? 0);
  if (depth === 0) return 'none';
  return depth % 2 === 1 ? 'live' : 'reReversed';
}
