/**
 * THE definition of an unreconciled bank LINE, for every "unreconciled" count: the bank-account card
 * (`bankAccountStatusService` unreconciled_count — bank_accounts_status, the bank_accounts export), the workbench and
 * attention panel (`workbenchService.getUnreconciledBankTxns`), the bureau cockpit's Bank reconciliation signal and the
 * period-close check (`gl/closeReadinessChecks/bankReconciledCheck`, the period's lines only). That check's `fail`
 * blocks only MCP `close_fiscal_period` today; the app's Close, Bulk Close and Close Year and the year-end close run no
 * readiness check yet (follow-up PR) — see bankReconciledCheck's header.
 *
 * The line test is shared; the ACCOUNTS each count covers are not. The card is per account, over leaf bank-subtype
 * accounts only (a rollup bank account with a bank child has no card; inactive accounts only with includeInactive), so
 * a line on a rollup, an inactive or a non-bank-subtype account is on no card. The workbench, attention, bureau and
 * period-close counts take every posted line of the company, whatever account it sits on. So the company totals can
 * exceed the sum of the cards, by design (tests/integration/bank-unreconciled-counts.int.test.ts pins both).
 *
 * A posted statement line that is neither reconciled nor excluded. 'reconciled' covers both a completed
 * reconciliation and the Sage import (status 'reconciled', no reconciliation_id; `reconciledCash.ts`). Review is a
 * stamp since migration 980 (#1308) and changes no status, so a reviewed line stays unreconciled until a
 * reconciliation completes — the bank-transactions Reviewed tab's Not Reconciled filter. Before #1308 these counts
 * left out 'matched' (the old Review flipped lines there), the card also left out 'provisional', and the period-close
 * check counted only 'imported' and 'matched'.
 *
 * Not this: the card's `unreconciledBalance` / `reconciledBalance` are journal-based (a line with no journal line, not
 * excluded / a line with one), whatever its reconciliation state.
 *
 * Pending feed lines are not on the statement yet and removed ones are gone, so neither counts.
 *
 * A fixed literal over the alias `bt` — nothing is interpolated — so it is safe for `sql.unsafe`.
 */
export const UNRECONCILED_LINE_SQL = "(bt.feed_state = 'posted' AND bt.status NOT IN ('reconciled', 'excluded'))";
