/**
 * The journals a bank-first provisional holds: ONE set, read by every GL-line candidate list that a statement line can
 * be matched to (the transaction picker `fetchJournalLineCandidates`, and `reconcilableGlLineWhere`: the
 * reconciliation's manual-match list and auto-match).
 *
 * A provisional journal X carries its own statement line through `bank_transactions.provisional_je_id`, so X's bank leg
 * is already that line's movement; `matchTransaction` refuses a second statement line on it (LINE_CLAIMED). It reads
 * the hold through the reversal chain (`findJournalChainRoot`): a re-reversed provisional's live head is held too
 * (sec-nrfa round 23, brk-nrfa round 24). This set is the same rule computed ONCE for the company, walking DOWN from
 * every held provisional (a journal is held iff its chain reaches one), bounded and company-scoped like every walk.
 *
 * Use as `jl.journal_entry_id NOT IN (${provisionallyHeldJournalIds(companyId)})`. DISTINCT keeps the NOT IN hashed
 * whatever the set's estimate (a plain SELECT spilled past hash_mem to a linear scan per candidate: 16-40 s with
 * thousands of held provisionals, sec-nrfa round 26 M1). A walk correlated to each candidate re-ran per line
 * (6 s at 200k lines, round 24 M1) or per leg x journal under a low estimate (139 s for a new
 * tenant, brk-nrfa round 25 M1). Filter on the LINE's journal id, not on je: on je the planner could pair every
 * unheld journal with every bank leg by a join filter (3-18 s, brk-nrfa round 27).
 */
import { sql } from '@/lib/neon';

export function provisionallyHeldJournalIds(companyId: string) {
  return sql`
          WITH RECURSIVE held AS (
            SELECT bp.provisional_je_id AS id, 0 AS d FROM bank_transactions bp
            WHERE bp.provisional_je_id IS NOT NULL AND bp.company_id = ${companyId}::UUID
            UNION ALL SELECT c.id, held.d + 1 FROM gl_journal_entries c JOIN held ON c.reversal_of_id = held.id
              WHERE c.company_id = ${companyId}::UUID AND held.d < 64)
          SELECT DISTINCT id FROM held`;
}
