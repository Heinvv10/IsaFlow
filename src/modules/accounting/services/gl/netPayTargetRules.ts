/**
 * May this account take payroll net pay in place of the bank? Pure, so the
 * Default Accounts save (gl/defaultAccountsService), the page's options
 * (gl/defaultAccountRoles#roleCandidates) and the plan's resolver
 * (payroll/payrollJournalBank) share ONE rule.
 *
 * The `payroll_net_pay` setting (netPaySetting) holds a gl_accounts.id, or
 * nothing (net pay is then credited to the bank-role holder, as it always was).
 * It is NOT a system role: 2140/2150/2160/2170/2175 all carry the subtype
 * `payroll_liability`, and roles resolve by subtype.
 *
 * Why it exists: Velocity Fibre pays salaries by bank lines allocated DR 2170 Net
 * Salaries Payable / CR bank. A pay run that also credited the bank would count
 * net pay twice; crediting 2170 is what those bank lines clear.
 *
 * ALLOW-LIST, not deny-list (ledger review, 2026-11-05). The account must be an
 * active, leaf LIABILITY whose subtype is `payroll_liability` once spellings are
 * normalised (`canonicalSubtype`: `payroll_liabilities` too), and not one the
 * journal already credits for something else (2140 PAYE, 2150 UIF, 2160 SDL, 2175
 * deductions: sharing one would net two obligations into one line).
 * Everything else is refused, on purpose: a null subtype, `tax` (the VAT201 reads
 * every `tax` line as output VAT), payables, bank and credit-card spellings (their
 * reconciliations pick the credit up), long-term and current-portion loan
 * accounts (net pay owed would read as non-current debt and the salary bank
 * lines that clear it as financing). An account the loan engine writes
 * (`loans.*_account_id`) is refused whatever its subtype: that needs a query, so
 * it is `netPayLoanAccountRefusal` (gl/netPayLoanAccounts), asked by the save and the plan.
 */
import type { CandidateAccount } from './defaultAccountRoles';
import { canonicalSubtype, type CanonicalSubtype } from './accountSubtypes';

/** The accounts the payroll journal credits besides net pay (payrollJournalParts' required and optional codes, bar labour). */
export const NET_PAY_CONFLICT_CODES: readonly string[] = ['2140', '2150', '2160', '2175'];

/** The one subtype a net-pay target may carry (after `canonicalSubtype`). */
export const NET_PAY_TARGET_SUBTYPE: CanonicalSubtype = 'payroll_liability';

export interface NetPayTargetAccount {
  code: string;
  type: string;
  isActive: boolean;
  subtype: string | null;
  /** Omitted when the caller judges the header rule itself (the plan: the poster's own `assertNoHeaderAccountLines`). */
  hasChildren?: boolean;
}

export type NetPayRefusalCode =
  | 'not_liability_net_pay_account'
  | 'inactive_net_pay_account'
  | 'header_net_pay_account'
  | 'net_pay_account_conflict'
  | 'not_payroll_liability_net_pay_account'
  | 'loan_net_pay_account';

export interface NetPayRefusal {
  code: NetPayRefusalCode;
  message: string;
}

const refuse = (code: NetPayRefusalCode, message: string): NetPayRefusal => ({ code, message });

/**
 * Why `target` cannot take net pay, or null. `allowInactive` is for the plan:
 * a deactivated account is its `inactive_target_account` blocker there, named
 * with every other deactivated target, while the save refuses it outright.
 */
export function netPayTargetRefusal(target: NetPayTargetAccount, opts: { allowInactive?: boolean } = {}): NetPayRefusal | null {
  const { code } = target;
  if (target.type !== 'liability') {
    return refuse('not_liability_net_pay_account',
      `Account ${code} has the type '${target.type || 'none'}': net pay is owed to employees, so its clearing account must be a liability`);
  }
  if (!target.isActive && !opts.allowInactive) {
    return refuse('inactive_net_pay_account', `Account ${code} is inactive`);
  }
  if (target.hasChildren === true) {
    return refuse('header_net_pay_account',
      `Account ${code} is a header with sub-accounts; choose one of its sub-accounts for payroll net pay`);
  }
  if (NET_PAY_CONFLICT_CODES.includes(code)) {
    return refuse('net_pay_account_conflict',
      `Account ${code} is already credited by the payroll journal for PAYE, UIF, SDL or other deductions; net pay needs an account of its own`);
  }
  // '' is no subtype (migration 674's trigger stores it as NULL).
  if (canonicalSubtype(target.subtype) !== NET_PAY_TARGET_SUBTYPE) {
    return refuse('not_payroll_liability_net_pay_account',
      `Account ${code} has ${target.subtype ? `the subtype '${target.subtype}'` : 'no subtype'}: payroll net pay may only go to a liability with the `
      + `'${NET_PAY_TARGET_SUBTYPE}' subtype (such as 2170 Net Salaries Payable). Set that subtype in the chart of accounts first, or choose another account`);
  }
  return null;
}

/**
 * The accounts the save would accept for the row, from the WHOLE chart (inactive
 * rows included: an inactive child still makes its parent a header), plus
 * `current`, kept even when it would not pass today so the select still names it.
 * (A loan-engine account on the right subtype is refused by the save, not here: the page holds no loans.)
 */
export function netPayCandidates<T extends CandidateAccount>(accounts: readonly T[], current?: string): T[] {
  const parents = new Set(accounts.map((a) => a.parentAccountId).filter(Boolean));
  return accounts.filter((a) => a.id === current || netPayTargetRefusal({
    code: a.accountCode ?? '', type: a.accountType ?? '', isActive: a.isActive === true,
    subtype: a.accountSubtype === '' ? null : a.accountSubtype ?? null, hasChildren: parents.has(a.id),
  }) === null);
}
