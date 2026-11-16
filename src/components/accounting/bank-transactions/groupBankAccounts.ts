/**
 * groupBankAccounts — splits the flat bank-account list into primary accounts
 * and sub-account groups. A sub-account is any bank account whose parent is
 * also a bank-subtype GL account (e.g. employee paycards under a "Paycards"
 * umbrella); the API surfaces that as groupId/groupName on each leaf.
 *
 * A group's figures are the sums of its members' INTEGER CENTS and counts (WP1), so they cannot drift from the cards.
 */

import type { BankAccountSummary } from './useBankTxSummary';

export interface BankAccountGroup {
  groupId: string;
  groupName: string;
  groupCode: string | null;
  accounts: BankAccountSummary[];
  ledgerCents: number;
  toCode: number;
  toCodeInCents: number;
  toCodeOutCents: number;
  allocated: number;
  suggested: number;
  unallocated: number;
}

export interface GroupedBankAccounts {
  primaries: BankAccountSummary[];
  groups: BankAccountGroup[];
}

export function groupBankAccounts(accounts: BankAccountSummary[]): GroupedBankAccounts {
  const primaries: BankAccountSummary[] = [];
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
        ledgerCents: 0, toCode: 0, toCodeInCents: 0, toCodeOutCents: 0, allocated: 0, suggested: 0, unallocated: 0,
      };
      byGroup.set(acct.groupId, group);
    }
    group.accounts.push(acct);
    group.ledgerCents += acct.ledgerCents;
    group.toCode += acct.counts.toCode;
    group.toCodeInCents += acct.toCodeInCents;
    group.toCodeOutCents += acct.toCodeOutCents;
    group.allocated += acct.counts.allocated;
    group.suggested += acct.counts.suggested;
    group.unallocated += acct.counts.unallocated;
  }

  return { primaries, groups: [...byGroup.values()] };
}
