/**
 * The ONE marker of the year-end closing journal (G-01).
 *
 * `yearEndJournalPoster` posts a REAL journal with this source, dated the fiscal
 * year end, that debits every revenue account and credits every expense account
 * to zero into retained earnings. It stays in the ledger as the lock and audit
 * record of the close, and it stays visible in the raw-ledger views (journal list
 * and detail, GL line export, audit trail, integrity checks).
 *
 * Every REPORT and STATEMENT must ignore it, both legs, because the reporting
 * layer DERIVES the close instead (trialBalanceBasis `getRetainedEarningsBroughtForward`,
 * balanceSheetService `calculateRetainedEarnings`, fiscalYearCloseRows). Counting the
 * real journal as well reads the close twice: the closed year's P&L prints 0, the
 * statement of changes in equity books the profit as Dividends, and the retained
 * earnings account (which carries the close's credit) is added to the derived
 * figure. A reversed close and the contra that reverses it carry the same source
 * (`reverseJournalEntry` copies it), so one predicate covers the whole chain: the
 * original, its reversal and any re-close.
 *
 * The WRITE side is the opposite: `yearEndJournalBuilder` (`loadPLBalances`,
 * `reloadNetIncome`) must SEE the close, or a re-run would try to close a closed
 * year again.
 *
 * Bound as a PARAMETER — `je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}` — not
 * spliced as a nested `sql` fragment, so it adds no call to a positionally mocked
 * `sql` in the unit suite (the precedent is `VAT_SUBMISSION_CLEARING_SOURCE`).
 * IS DISTINCT FROM, never `<>`: `source` is nullable and `NULL <> x` is NULL,
 * which would drop every NULL-source journal.
 * tests/unit/guards/yearEndJournalCensus.test.ts fails when a reader that sums
 * ledger lines into a figure lacks it; docs/fixes/g01-census.md classifies each.
 */
export const YEAR_END_JOURNAL_SOURCE = 'year_end';
