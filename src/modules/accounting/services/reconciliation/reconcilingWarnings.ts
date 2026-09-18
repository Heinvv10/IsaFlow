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
import type { ReconcilingItem } from './reconcilingItemTypes';
import type { OffControlCash } from './unappliedCashTypes';

export type WarningRow = { id: string; reason: string; detail?: string; amount?: number };

/**
 * A control-bridge item whose members cancel to exactly nothing.
 *
 * Items are emitted per REASON, so a group can net to zero while holding real
 * rows — a journal reversed but whose document was never cancelled at −1,150
 * beside a document cancelled but whose journal was never reversed at +1,150.
 * An item of 0.00 explains nothing and reads to an agent as a finding that
 * resolves itself, so it is not emitted; but two errors that cancel are still
 * two errors, so the rows are named here instead of vanishing with it.
 */
export function netZeroItemWarnings(items: readonly ReconcilingItem[]): WarningRow[] {
  return items
    .filter((i) => i.bridge === 'subledger_to_control' && i.amount === 0 && i.documentIds.length > 0)
    .map((i) => ({
      id: i.documentIds[0]!,
      reason: 'net_zero_reconciling_item',
      detail: `${i.documentIds.length} row(s) reported as ${i.type} cancel one another exactly, so they explain no part of the difference and are not a reconciling item. They are still two findings rather than none: ${i.documentNumbers.slice(0, 12).join(', ') || i.documentIds.slice(0, 12).join(', ')}.`,
      amount: 0,
    }));
}

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

/**
 * Payments whose two figures disagree: what the DOCUMENT says is unapplied,
 * and what the payment actually moved the CONTROL ACCOUNT by.
 *
 * The wording states the subtraction and nothing more. It used to assert the
 * cash "never reached a control account", which is one of three ways the two
 * can differ and the only one it named: the posting can be PARTIAL, it can have
 * been REVERSED, and on a supplier refund (DR Bank / CR Accounts Payable) it
 * reaches the control account in the OPPOSITE direction — where the amount
 * below is the two figures' span rather than a shortfall.
 */
export function offControlCashWarnings(rows: readonly OffControlCash[]): WarningRow[] {
  return rows.map((p) => ({
    id: p.paymentId,
    reason: 'unapplied_cash_off_control_account',
    detail: `${p.documentNumber ?? 'This payment'} is unapplied by its document — list_unapplied_receipts / list_unapplied_payments count it that way — and this is that figure LESS what the payment moved the control account by. The two differ when the posting is partial, when it has been reversed, or when it went the other way. A REFUND went the other way, and the figure below is then the SPAN between the two rather than a shortfall: a R500 refund counted as R500 unapplied by its document and −R500 on the control account shows here as R1,000. The reconciling item carries the control-account figure, because that is the part of the difference this payment explains.`,
    amount: p.amount,
  }));
}
