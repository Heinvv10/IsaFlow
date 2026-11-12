/**
 * Which accounts the supplier-bill line picker offers: the same set the server
 * accepts (`billLineAccountProblem`), chosen by account type and subtype rather
 * than by a code range, so asset, stock and prepayment accounts and the
 * three-digit charts are included.
 */
import { billLineAccountProblem } from '@/modules/accounting/services/ap/billLineAccountRules';
import type { GLAccount as ChartAccount } from '@/modules/accounting/types/gl.types';

export interface BillAccountChoice {
  id: string;
  accountCode: string;
  accountName: string;
  accountType?: string;
}

export interface BillAccountGroup {
  label: string;
  accounts: BillAccountChoice[];
}

type ChartRow = Pick<ChartAccount, 'id' | 'accountCode' | 'accountName' | 'accountType' | 'isActive'>
  & Partial<Pick<ChartAccount, 'accountSubtype' | 'parentAccountId'>>;

/** `all` is the whole chart including inactive rows, so a header whose only child is inactive is still a header. */
export function billLineAccountChoices(all: readonly ChartRow[]): BillAccountChoice[] {
  const parents = new Set(all.map((a) => a.parentAccountId).filter((id): id is string => !!id));
  return all
    .filter((a) => billLineAccountProblem({
      account_code: a.accountCode,
      account_name: a.accountName,
      account_subtype: a.accountSubtype ?? null,
      is_active: a.isActive,
      has_children: parents.has(a.id),
    }) === null)
    .map((a) => ({ id: a.id, accountCode: a.accountCode, accountName: a.accountName, accountType: a.accountType }))
    .sort((x, y) => x.accountCode.localeCompare(y.accountCode));
}

const GROUPS: readonly { type: string; label: string }[] = [
  { type: 'expense', label: 'Expenses' },
  { type: 'asset', label: 'Assets' },
  { type: 'liability', label: 'Liabilities' },
  { type: 'equity', label: 'Equity' },
  { type: 'revenue', label: 'Income' },
];

export const PO_GROUP_LABEL = 'From the purchase order';

/** Groups in a fixed order; an account with no type (merged in from a PO line) goes last. Empty groups are dropped. */
export function groupBillAccounts(accounts: readonly BillAccountChoice[]): BillAccountGroup[] {
  const known = new Set(GROUPS.map((g) => g.type));
  const groups = GROUPS.map((g) => ({ label: g.label, accounts: accounts.filter((a) => a.accountType === g.type) }));
  groups.push({ label: PO_GROUP_LABEL, accounts: accounts.filter((a) => !a.accountType || !known.has(a.accountType)) });
  return groups.filter((g) => g.accounts.length > 0);
}
