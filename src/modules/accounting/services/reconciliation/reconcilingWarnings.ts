/**
 * Things worth saying that are NOT reconciling items.
 *
 * Both of these describe money that moved somewhere the reconciliation does not
 * count, and both used to be silent. The temptation in each case is to fold
 * them into an item so the numbers look complete — which is how a
 * `settle_by_contra` loan account became an AP control account and moved R453m
 * of one production reconciliation. An item explains part of
 * `subledgerTotal − controlAccountBalance`; neither of these does, so neither
 * may be one. They go on `excludedRows`, where a reader sees them and the
 * arithmetic does not.
 */

import type { NonControlPostingAccount } from '../gl/nonControlPostingAccounts';
import type { OffControlCash } from './unappliedCashTypes';

export type WarningRow = { id: string; reason: string; detail?: string; amount?: number };

/** Accounts this subledger's documents move that are not typed for the role. */
export function nonControlPostingWarnings(
  role: string,
  accounts: readonly NonControlPostingAccount[],
): WarningRow[] {
  const ROLE = role.toUpperCase();
  return accounts.map((a) => ({
    id: a.accountId,
    reason: 'postings_on_non_control_accounts',
    detail: `${a.accountCode} ${a.accountName} carries ${ROLE}-direction movement from ${ROLE} documents and is not typed as a ${ROLE} control account (subtype ${a.accountSubtype ?? 'NULL'}), so it is NOT counted in controlAccountBalance. Documents whose value went there are reported as document_not_on_control_account.`,
    amount: a.amount,
  }));
}

/** Payments the listing tools call unapplied whose cash is not on control. */
export function offControlCashWarnings(rows: readonly OffControlCash[]): WarningRow[] {
  return rows.map((p) => ({
    id: p.paymentId,
    reason: 'unapplied_cash_off_control_account',
    detail: `${p.documentNumber ?? 'This payment'} is unapplied by its document — list_unapplied_receipts / list_unapplied_payments count it — but this much of it never reached a control account, so it explains no part of the difference and is NOT a reconciling item.`,
    amount: p.amount,
  }));
}
