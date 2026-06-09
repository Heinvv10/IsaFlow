/**
 * groupBankAccounts — splits the flat bank-account list into primary accounts
 * and sub-account groups (e.g. employee paycards under a bank-subtype parent).
 */

import { describe, it, expect } from 'vitest';
import { groupBankAccounts } from '@/components/accounting/bank-transactions/groupBankAccounts';
import type { BankAcct } from '@/components/accounting/bank-transactions/BankTxBankCards';

function acct(overrides: Partial<BankAcct> & { id: string }): BankAcct {
  return {
    accountCode: overrides.id,
    accountName: `Account ${overrides.id}`,
    balance: 0,
    reconciledBalance: 0,
    unreconciledBalance: 0,
    unreconciledCount: 0,
    allocatedCount: 0,
    unallocatedCount: 0,
    ...overrides,
  };
}

describe('groupBankAccounts', () => {
  it('returns all accounts as primaries when none have a group', () => {
    const accounts = [acct({ id: 'a' }), acct({ id: 'b' })];
    const result = groupBankAccounts(accounts);
    expect(result.primaries).toHaveLength(2);
    expect(result.groups).toHaveLength(0);
  });

  it('collects sub-accounts into one group per groupId, preserving order', () => {
    const accounts = [
      acct({ id: 'main' }),
      acct({ id: 'pc1', groupId: 'g1', groupName: 'STD Paycards' }),
      acct({ id: 'pc2', groupId: 'g1', groupName: 'STD Paycards' }),
      acct({ id: 'float1', groupId: 'g2', groupName: 'Petty Cash Floats' }),
    ];
    const result = groupBankAccounts(accounts);
    expect(result.primaries.map(a => a.id)).toEqual(['main']);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toMatchObject({ groupId: 'g1', groupName: 'STD Paycards' });
    expect(result.groups[0]!.accounts.map(a => a.id)).toEqual(['pc1', 'pc2']);
    expect(result.groups[1]!.accounts.map(a => a.id)).toEqual(['float1']);
  });

  it('rolls up balances and counts onto the group', () => {
    const accounts = [
      acct({ id: 'pc1', groupId: 'g1', groupName: 'Paycards', balance: 150.5, unallocatedCount: 3, allocatedCount: 2, unreconciledBalance: 50 }),
      acct({ id: 'pc2', groupId: 'g1', groupName: 'Paycards', balance: -20.25, unallocatedCount: 1, allocatedCount: 0, unreconciledBalance: -10 }),
    ];
    const [group] = groupBankAccounts(accounts).groups;
    expect(group!.balance).toBeCloseTo(130.25, 2);
    expect(group!.unallocatedCount).toBe(4);
    expect(group!.allocatedCount).toBe(2);
    expect(group!.unreconciledBalance).toBeCloseTo(40, 2);
  });

  it('treats an account with a groupId but missing groupName as primary (defensive)', () => {
    const accounts = [acct({ id: 'odd', groupId: 'g1' })];
    const result = groupBankAccounts(accounts);
    expect(result.primaries.map(a => a.id)).toEqual(['odd']);
    expect(result.groups).toHaveLength(0);
  });

  it('handles empty input', () => {
    const result = groupBankAccounts([]);
    expect(result.primaries).toEqual([]);
    expect(result.groups).toEqual([]);
  });
});
