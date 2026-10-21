/**
 * The ONE marker of a take-on / opening-balance journal: source = 'auto_migration'.
 *
 * Written only by the take-on writers pinned in
 * tests/unit/services/afs/takeOnJournalWriterCensus.test.ts — the migration
 * wizard's opening balances and AR/AP take-on documents, the file migration's
 * opening balances, Import from Sage (through the wizard's steps), and the MCP
 * set_opening_balance — and copied to a reversal by reverseJournalEntry, so a
 * reversed take-on nets inside the same predicate. Sage live history the
 * Britech script once wrote with it was relabelled by migration 908.
 *
 * What it means to a STATEMENT: a balance brought into IsaFlow, not a movement
 * of the period. The report SOCE (changesInEquityService) puts its equity
 * postings on "Balances taken on"; the AFS SOCE's dividends paid
 * (dividendsPaid.fetchDividendsPaid, paidOnly) leaves its dividends out, so the
 * two statements agree. The balance sheet reads the balance whatever posted it.
 *
 * Bound as a PARAMETER (`je.source = ${TAKE_ON_JOURNAL_SOURCE}`), like
 * YEAR_END_JOURNAL_SOURCE, so it adds no call to a positionally mocked `sql`.
 */
export const TAKE_ON_JOURNAL_SOURCE = 'auto_migration';
