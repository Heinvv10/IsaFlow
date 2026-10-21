/**
 * Which journals of Sage's journal history are Sage's own opening balances: a
 * take-on (TAKE_ON_JOURNAL_SOURCE), unlike the live history around them, which is a GL import.
 *
 * Sage marks them with the description "O/B from other system" or the reference
 * "O/balance" / "O/B". Compared case-insensitively; trailing spaces and . , ; : !
 * are ignored on the description, surrounding spaces on the reference.
 *
 * The same predicate as migration 908 (scripts/migrations/sql/908_relabel_sage_history_journals.sql,
 * `lower(rtrim(description, ' .,;:!'))` and `lower(btrim(reference))`), which relabelled what
 * scripts/import-sage-britech.ts wrote before it used this; the two are held together by
 * tests/integration/m908-relabel-sage-history.int.test.ts.
 */
const OPENING_DESCRIPTION = 'o/b from other system';
const OPENING_REFERENCES: ReadonlySet<string> = new Set(['o/balance', 'o/b']);

export function isSageOpeningBalanceJournal(description: string | null | undefined, reference: string | null | undefined): boolean {
  const desc = (description ?? '').replace(/[ .,;:!]+$/, '').toLowerCase();
  const ref = (reference ?? '').replace(/^ +| +$/g, '').toLowerCase();
  return desc === OPENING_DESCRIPTION || OPENING_REFERENCES.has(ref);
}
