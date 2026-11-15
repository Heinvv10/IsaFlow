/**
 * THE definition of an unreconciled bank line, for every "unreconciled" count: the bank-account card
 * (`bankAccountStatusService` unreconciled_count — bank_accounts_status, the bank_accounts export), the workbench and
 * attention panel (`workbenchService.getUnreconciledBankTxns`) and the bureau cockpit's Bank reconciliation signal.
 *
 * A posted statement line that is neither reconciled nor excluded. 'reconciled' covers both a completed
 * reconciliation and the Sage import (status 'reconciled', no reconciliation_id; `reconciledCash.ts`). Review is a
 * stamp since migration 980 (#1308) and changes no status, so a reviewed line stays unreconciled until a
 * reconciliation completes — the bank-transactions Reviewed tab's Not Reconciled filter. Before #1308 these counts
 * left out 'matched' (the old Review flipped lines there) and the card also left out 'provisional'.
 *
 * Pending feed lines are not on the statement yet and removed ones are gone, so neither counts.
 *
 * A fixed literal over the alias `bt` — nothing is interpolated — so it is safe for `sql.unsafe`.
 */
export const UNRECONCILED_LINE_SQL = "(bt.feed_state = 'posted' AND bt.status NOT IN ('reconciled', 'excluded'))";
