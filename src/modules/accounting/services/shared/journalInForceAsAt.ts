/**
 * Whether a posted journal STANDS as at a date, read from its reversal chain.
 *
 * `reversed_at` is a one-link marker: reverseJournalEntry sets it on the entry
 * it reverses and never clears it. Reversing the reversal (C <- R <- R2) sets
 * it on R and leaves C marked, so `C.reversed_at IS NULL` reads C as reversed
 * for ever although R2 has reinstated it, and it reads C as reversed at every
 * date, including dates before R existed.
 *
 * The dated answer is the chain's PARITY (defect D8, 2026-10-02: the same rule
 * shared/softDeleteLedgerPresence applies to a deleted document's journal):
 * C stands as at D exactly when an EVEN number of the posted entries
 * reversing it (R, R2, R3 ... never C) are dated on or before D. The UNIQUE on
 * (company_id, reversal_of_id) keeps the chain linear, so the walk IS the chain.
 *
 * PRECONDITION, as for the soft-delete predicate: no reversal is dated before
 * the entry it reverses, so the entries dated on or before D are a PREFIX of
 * the chain and their parity is its net position. See the header of
 * softDeleteLedgerPresence for the one shape that can still break it.
 *
 * The caller asserts the journal itself is posted; an unposted one has no
 * reversals and reads TRUE.
 *
 * Built with ONE `sql.unsafe` (not a nested tagged template) for the reason
 * softDeleteLedgerPresence gives: a nested `sql` call consumes a queued mock
 * row in every unit suite that stubs `@/lib/neon`. INTERPOLATION ONLY — the
 * return is a thenable, and awaiting it sends the bare fragment as a statement.
 *
 * @param journalIdColumn a column reference written in code (`lc.id`), never
 *   input: it is spliced into the SQL text.
 */
import { sql } from '@/lib/neon';

/** As at `asAtStr` ('YYYY-MM-DD'): only reversals dated on or before it count. For a dated report. */
export function journalInForceAsAtFragment(journalIdColumn: string, asAtStr: string, companyId: string) {
  return chainParity(journalIdColumn, companyId, asAtStr);
}

/**
 * As the ledger stands NOW: every posted reversal counts, whatever its date —
 * the reading `reversed_at` gives a single reversal, so a write guard swapping
 * `reversed_at IS NULL` for this changes nothing but the re-reversed chain.
 */
export function journalStandsFragment(journalIdColumn: string, companyId: string) {
  return chainParity(journalIdColumn, companyId, null);
}

function chainParity(journalIdColumn: string, companyId: string, asAtStr: string | null) {
  return sql.unsafe(
    `(WITH RECURSIVE reversals AS (
        SELECT r.id, r.entry_date
        FROM gl_journal_entries r
        WHERE r.reversal_of_id = ${journalIdColumn}
          AND r.company_id = $1::UUID AND r.status = 'posted'
        UNION ALL
        SELECT j.id, j.entry_date
        FROM gl_journal_entries j
        JOIN reversals ON j.reversal_of_id = reversals.id
        WHERE j.company_id = $1::UUID AND j.status = 'posted'
      )
      SELECT COUNT(*) FILTER (WHERE $2::DATE IS NULL OR reversals.entry_date <= $2::DATE) % 2 = 0
      FROM reversals)`,
    [companyId, asAtStr],
  );
}
