/**
 * groupBankAccounts — splits the flat bank-account list into primary accounts
 * and sub-account groups (e.g. employee paycards under a bank-subtype parent).
 */

import { describe, it, expect } from 'vitest';
import { groupBankAccounts } from '@/components/accounting/bank-transactions/groupBankAccounts';
import { summaryAcct } from '../helpers/bankSummaryFixture';
import type { BankAccountSummary } from '@/modules/accounting/services/bank/bankAccountSummaryService';

function acct(o: Partial<BankAccountSummary> & { id: string }): BankAccountSummary {
  return summaryAcct(o.id, o);
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

  it('rolls up ledger cents, counts and to-code money onto the group, in exact integer cents', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; as cents (10 + 20) it is exact.
    const accounts = [
      acct({ id: 'pc1', groupId: 'g1', groupName: 'Paycards', ledgerCents: 10, toCodeInCents: 2505, toCodeOutCents: -1001,
        counts: { allocated: 2, suggested: 1, unallocated: 3 } }),
      acct({ id: 'pc2', groupId: 'g1', groupName: 'Paycards', ledgerCents: 20, toCodeInCents: 7, toCodeOutCents: -3003,
        counts: { allocated: 0, suggested: 0, unallocated: 1 } }),
    ];
    const [group] = groupBankAccounts(accounts).groups;
    expect(group).toMatchObject({
      ledgerCents: 30, toCode: 5, toCodeInCents: 2512, toCodeOutCents: -4004, allocated: 2, suggested: 1, unallocated: 4,
    });
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
