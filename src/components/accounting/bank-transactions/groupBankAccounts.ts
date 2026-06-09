/**
 * groupBankAccounts — splits the flat bank-account list into primary accounts
 * and sub-account groups. A sub-account is any bank account whose parent is
 * also a bank-subtype GL account (e.g. employee paycards under a "Paycards"
 * umbrella); the API surfaces that as groupId/groupName on each leaf.
 */

import type { BankAcct } from './BankTxBankCards';

export interface BankAccountGroup {
  groupId: string;
  groupName: string;
  groupCode: string | null;
  accounts: BankAcct[];
  balance: number;
  reconciledBalance: number;
  unreconciledBalance: number;
  unreconciledCount: number;
  allocatedCount: number;
  unallocatedCount: number;
}

export interface GroupedBankAccounts {
  primaries: BankAcct[];
  groups: BankAccountGroup[];
}

export function groupBankAccounts(accounts: BankAcct[]): GroupedBankAccounts {
  const primaries: BankAcct[] = [];
  const byGroup = new Map<string, BankAccountGroup>();

  for (const acct of accounts) {
    // groupName missing means the parent row wasn't resolvable — fail open
    // to a primary card rather than an unlabelled group.
    if (!acct.groupId || !acct.groupName) {
      primaries.push(acct);
      continue;
    }
    let group = byGroup.get(acct.groupId);
    if (!group) {
      group = {
        groupId: acct.groupId,
        groupName: acct.groupName,
        groupCode: acct.groupCode ?? null,
        accounts: [],
        balance: 0,
        reconciledBalance: 0,
        unreconciledBalance: 0,
        unreconciledCount: 0,
        allocatedCount: 0,
        unallocatedCount: 0,
      };
      byGroup.set(acct.groupId, group);
    }
    group.accounts.push(acct);
    group.balance += acct.balance;
    group.reconciledBalance += acct.reconciledBalance;
    group.unreconciledBalance += acct.unreconciledBalance;
    group.unreconciledCount += acct.unreconciledCount;
    group.allocatedCount += acct.allocatedCount;
    group.unallocatedCount += acct.unallocatedCount;
  }

  return { primaries, groups: [...byGroup.values()] };
}
