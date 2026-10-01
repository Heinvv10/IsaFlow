import { describe, it, expect } from 'vitest';
import { countPostedAccounts } from '@/components/reports/generalLedgerRows';

describe('countPostedAccounts', () => {
  it('leaves out the derived Retained Earnings b/f account', () => {
    const accounts = [{ accountCode: '1000' }, { accountCode: '4000' }, { accountCode: 'RE-BF', derived: true }];
    expect(countPostedAccounts(accounts)).toBe(2);
  });

  it('counts every account when none is derived, and zero for an empty report', () => {
    expect(countPostedAccounts([{ accountCode: '1000' }, { accountCode: '2000', derived: false }])).toBe(2);
    expect(countPostedAccounts([])).toBe(0);
  });
});
