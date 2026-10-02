/**
 * The Default Accounts rows that manage a system role, and which accounts each
 * may be given. Pure (no database), so the save (`defaultAccountsService`) and
 * the page (`pages/accounting/default-accounts`) share ONE map and ONE rule:
 * the page offers, for a role row, exactly the accounts `roleTargetRefusal`
 * would let the save accept — an income-statement role may go to a header, a
 * balance-sheet one may not (Hein, 2026-10-02).
 */
import type { SystemAccountKey } from './systemAccountKeys';
import { roleTargetRefusal } from './roleTargetRules';

/** UI setting key → the role (system account subtype) it manages. */
export const DEFAULT_ACCOUNT_ROLES: Readonly<Record<string, SystemAccountKey>> = {
  sales_revenue: 'default_revenue',
  sales_vat_output: 'vat_output',
  accounts_receivable: 'receivable',
  cost_of_sales: 'default_expense',
  purchase_vat_input: 'vat_input',
  accounts_payable: 'payable',
  primary_bank: 'bank',
  retained_earnings: 'retained_earnings',
  opening_balance_equity: 'opening_balance_equity',
};

/** The role a UI key manages — own keys only, so `constructor` is ignored like any unknown key. */
export function defaultAccountRole(uiKey: string): SystemAccountKey | undefined {
  return Object.hasOwn(DEFAULT_ACCOUNT_ROLES, uiKey) ? DEFAULT_ACCOUNT_ROLES[uiKey] : undefined;
}

/** The fields of a chart-of-accounts row the rule reads. */
export interface CandidateAccount {
  id: string;
  accountCode?: string;
  accountType?: string;
  accountSubtype?: string | null;
  parentAccountId?: string | null;
  isActive?: boolean;
}

/**
 * The accounts the save would accept for `uiKey`, from the WHOLE chart
 * (inactive rows included: a child that is inactive still makes its parent a
 * header), plus `current` — the holder the page shows, kept even when it would
 * not pass today so the select still names it. A row that manages no role
 * offers every active account.
 */
export function roleCandidates<T extends CandidateAccount>(uiKey: string, accounts: readonly T[], current?: string): T[] {
  const role = defaultAccountRole(uiKey);
  if (!role) return accounts.filter((a) => a.isActive === true || a.id === current);
  const parents = new Set(accounts.map((a) => a.parentAccountId).filter(Boolean));
  return accounts.filter((a) => a.id === current || roleTargetRefusal(role, uiKey, {
    code: a.accountCode ?? '', type: a.accountType ?? '', isActive: a.isActive === true,
    hasChildren: parents.has(a.id), subtype: a.accountSubtype ?? null,
  }) === null);
}
