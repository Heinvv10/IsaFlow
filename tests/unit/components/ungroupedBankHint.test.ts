/**
 * ungroupedBankHint — finds primary bank accounts that look like members of an
 * existing sub-account group (VF 2026-10-26: five "ABSA - PC : …" paycards
 * outside "Bank Transfer acc - ABSA Paycards").
 */

import { describe, it, expect } from 'vitest';
import { findUngroupedHints, namePrefix } from '@/components/accounting/bank-transactions/ungroupedBankHint';
import { groupBankAccounts } from '@/components/accounting/bank-transactions/groupBankAccounts';
import type { BankAcct } from '@/components/accounting/bank-transactions/BankTxBankCards';

function acct(id: string, accountName: string, group?: string): BankAcct {
  return {
    id, accountCode: id, accountName, balance: 0, reconciledBalance: 0, unreconciledBalance: 0,
    unreconciledCount: 0, allocatedCount: 0, unallocatedCount: 0,
    ...(group ? { groupId: group, groupName: `Group ${group}` } : {}),
  };
}

const hints = (accounts: BankAcct[]) => {
  const { primaries, groups } = groupBankAccounts(accounts);
  return findUngroupedHints(primaries, groups);
};

describe('namePrefix', () => {
  it('takes the text before the first ":" when there is one', () => {
    expect(namePrefix('ABSA - PC : 4374480006644540 - Stephan (stopped)')).toBe('absa - pc');
  });
  it('else the text before the first " - "', () => {
    expect(namePrefix('PC - Paycard - Byron Viviers (1662) - BA9188')).toBe('pc');
  });
  it('null when the name has no boundary', () => {
    expect(namePrefix('Petty Cash')).toBeNull();
    expect(namePrefix(': no prefix')).toBeNull();
  });
});

describe('findUngroupedHints', () => {
  const absaGroup = [
    acct('g1', 'ABSA - PC : 111 - Jody', 'absa'),
    acct('g2', 'ABSA - PC : 222 - Reynard', 'absa'),
  ];
  const strays = [
    acct('s1', 'ABSA - PC : 333 - Stephan (stopped)'),
    acct('s2', 'ABSA - PC : 444 - Ettiene 2'),
    acct('s3', 'absa - pc : 555'),
  ];

  it('three primaries sharing a group\'s prefix produce one hint naming that group', () => {
    const out = hints([acct('m', 'Velocity Fibre - ABSA - 4118819618'), ...absaGroup, ...strays]);
    expect(out).toHaveLength(1);
    expect(out[0]!.groupId).toBe('absa');
    expect(out[0]!.groupName).toBe('Group absa');
    expect(out[0]!.accounts.map(a => a.id)).toEqual(['s1', 's2', 's3']);
  });

  it('two strays are not enough', () => {
    expect(hints([...absaGroup, ...strays.slice(0, 2)])).toEqual([]);
  });

  it('no hint without a group whose members share the prefix', () => {
    expect(hints(strays)).toEqual([]);
    expect(hints([acct('x', 'Other - 1', 'absa'), acct('y', 'Other - 2', 'absa'), ...strays])).toEqual([]);
  });

  it('a group whose members mostly share the prefix still matches (one oddly named card)', () => {
    const out = hints([...absaGroup, acct('g3', 'Old card', 'absa'), ...strays]);
    expect(out.map(h => h.groupId)).toEqual(['absa']);
  });

  it('two groups with the same prefix are ambiguous: no hint', () => {
    expect(hints([...absaGroup, acct('h1', 'ABSA - PC : 9', 'other'), ...strays])).toEqual([]);
  });
});
