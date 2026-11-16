/** Pure decisions of the bank-transactions page shell, split out so they are testable and the page stays under 300 lines. */

import type { SelectOption } from '@/components/accounting/BankTxTable';
import type { BankAccountSummary } from './useBankTxSummary';
import type { BankTxTab } from './BankTxTabs';

export interface FilterValues {
  search: string; fromDate: string; toDate: string; fromAmount: string; toAmount: string;
  allocationFilter: string; txType: string; allocType: string; hasSuggestion: string;
}

/** Whether any filter narrows the list. */
export function filtersActive(f: FilterValues): boolean {
  return [f.search, f.fromDate, f.toDate, f.fromAmount, f.toAmount].some(v => v !== '')
    || [f.allocationFilter, f.txType, f.allocType, f.hasSuggestion].some(v => v !== 'all');
}

/**
 * The Awaiting-review tile's "n shown": the New tab's list total, only while filters narrow it AND that list loaded
 * (a failed or loading list has a total of 0, which would read "0 shown").
 */
export function awaitingShown(a: {
  tab: BankTxTab; filtersActive: boolean; error: string; isLoading: boolean; total: number;
  /** What the loaded total was counted for, and what is selected now (`listKey`): a stale total is never shown. */
  loadedFor: string; wantedFor: string;
}): number | null {
  return a.tab === 'new' && a.filtersActive && a.error === '' && !a.isLoading && a.loadedFor === a.wantedFor ? a.total : null;
}

/** The account and tab a list total belongs to. */
export const listKey = (bankId: string, tab: BankTxTab): string => `${bankId}|${tab}`;

/** The first ACTIVE account; '' when every account is inactive (nothing inactive is selected for the user). */
export function defaultBankId(accounts: BankAccountSummary[]): string {
  return accounts.find(b => b.isActive)?.id ?? '';
}

/** Every other ACTIVE bank account, sub-accounts carrying their group name so 20+ paycards stay scannable. */
export function transferTargetsFor(accounts: BankAccountSummary[], selectedBank: string): SelectOption[] {
  return accounts
    .filter(b => b.id !== selectedBank && b.isActive)
    .map(b => ({ id: b.id, code: b.accountCode, name: b.groupName ? `${b.groupName} › ${b.accountName}` : b.accountName }));
}

/** The selection to keep after the accounts (re)load: the current one while it still exists, else the default. */
export function keepOrDefault(accounts: BankAccountSummary[], current: string): string {
  return accounts.some(b => b.id === current) ? current : defaultBankId(accounts);
}
