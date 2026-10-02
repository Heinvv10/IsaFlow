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
 * CYCLE GUARD (D8 round 2): the unique index forbids two reversals of one
 * entry, not a loop, so a forged one would recurse for ever. The walk carries
 * its path (seeded with the journal itself) and stops at the first repeat or at
 * MAX_CHAIN_DEPTH; the parity of a looped chain is meaningless but it ends.
 *
 * Built with ONE `sql.unsafe` (not a nested tagged template) for the reason
 * softDeleteLedgerPresence gives: a nested `sql` call consumes a queued mock
 * row in every unit suite that stubs `@/lib/neon`. INTERPOLATION ONLY — the
 * return is a thenable, and awaiting it sends the bare fragment as a statement.
 *
 * @param journalIdColumn a column reference spliced into the SQL text, so it is
 *   a closed set of literals (D8 round 4): no caller can pass a value through.
 */
import { sql } from '@/lib/neon';
import { MAX_CHAIN_DEPTH } from './journalChainHead';

/** The journal-id columns the fragments may correlate on. Add an alias here, never widen to string. */
export type JournalIdColumn = 'je.id' | 'lc.id' | 'pje.id' | 'rje.id';

/** As at `asAtStr` ('YYYY-MM-DD'): only reversals dated on or before it count. For a dated report. */
export function journalInForceAsAtFragment(journalIdColumn: JournalIdColumn, asAtStr: string, companyId: string) {
  return chainParity(journalIdColumn, companyId, asAtStr);
}

/**
 * As the ledger stands NOW: every posted reversal counts, whatever its date —
 * the reading `reversed_at` gives a single reversal, so a write guard swapping
 * `reversed_at IS NULL` for this changes the re-reversed chain, and one more
 * shape: a journal STAMPED reversed with no posted contra (a broken chain — a
 * stranded claim, a hand edit) reads as standing, because the ledger does carry
 * it. That is the safe answer for a guard that BLOCKS while a journal stands.
 */
export function journalStandsFragment(journalIdColumn: JournalIdColumn, companyId: string) {
  return chainParity(journalIdColumn, companyId, null);
}

/**
 * For a guard that PERMITS an action on the journal itself (link a document to
 * it, evidence it): standing as above AND not a broken chain. A journal stamped
 * reversed with no posted contra was refused by the old `reversed_at IS NULL`
 * and stays refused (D8 round 5; r107 pins it) — permitting on it would act on
 * an entry whose state nobody can vouch for. The row must expose `reversed_at`
 * under the same alias.
 */
export function journalStandsUnbrokenFragment(journalIdColumn: JournalIdColumn, companyId: string) {
  const alias = journalIdColumn.split('.')[0];
  return sql.unsafe(
    `(${chainParitySql(journalIdColumn)} AND NOT (${alias}.reversed_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM gl_journal_entries r0
        WHERE r0.reversal_of_id = ${journalIdColumn} AND r0.company_id = $1::UUID AND r0.status = 'posted')))`,
    [companyId, null],
  );
}

function chainParity(journalIdColumn: JournalIdColumn, companyId: string, asAtStr: string | null) {
  return sql.unsafe(chainParitySql(journalIdColumn), [companyId, asAtStr]);
}

/** $1 = company id, $2 = as-at date or NULL (every posted reversal counts). */
function chainParitySql(journalIdColumn: JournalIdColumn): string {
  return `(WITH RECURSIVE reversals AS (
        SELECT r.id, r.entry_date, ARRAY[r.reversal_of_id, r.id] AS path
        FROM gl_journal_entries r
        WHERE r.reversal_of_id = ${journalIdColumn}
          AND r.company_id = $1::UUID AND r.status = 'posted'
        UNION ALL
        SELECT j.id, j.entry_date, reversals.path || j.id
        FROM gl_journal_entries j
        JOIN reversals ON j.reversal_of_id = reversals.id
        WHERE j.company_id = $1::UUID AND j.status = 'posted'
          AND NOT j.id = ANY(reversals.path) AND cardinality(reversals.path) < ${MAX_CHAIN_DEPTH}
      )
      SELECT COUNT(*) FILTER (WHERE $2::DATE IS NULL OR reversals.entry_date <= $2::DATE) % 2 = 0
      FROM reversals)`;
}
