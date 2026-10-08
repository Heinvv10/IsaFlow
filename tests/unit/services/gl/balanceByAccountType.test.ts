/**
 * The one rule for the sign of a balance-sheet account's balance: by ACCOUNT
 * TYPE, never by `normal_balance`. An asset is debit less credit; a liability
 * or equity account is credit less debit. A contra account (Accumulated
 * Depreciation, Dividends Declared, a debit-normal liability) therefore comes
 * out negative and reduces its own section.
 *
 * The balance sheet, its trend series, the consolidated balance sheet and the
 * subledger control balances all sign through this function.
 */
import { describe, it, expect } from 'vitest';
import { balanceByAccountType } from '@/modules/accounting/services/gl/balanceByAccountType';

describe('balanceByAccountType', () => {
  it('reads an asset debit less credit', () => {
    expect(balanceByAccountType('asset', 1000)).toBe(1000);
  });

  it('reads a contra-asset (net credit) as negative', () => {
    expect(balanceByAccountType('asset', -2000)).toBe(-2000);
  });

  it('reads a liability credit less debit', () => {
    expect(balanceByAccountType('liability', -500)).toBe(500);
  });

  it('reads a debit-normal liability (net debit) as negative', () => {
    expect(balanceByAccountType('liability', 300)).toBe(-300);
  });

  it('reads equity credit less debit, and dividends declared (net debit) as negative', () => {
    expect(balanceByAccountType('equity', -4000)).toBe(4000);
    expect(balanceByAccountType('equity', 1500)).toBe(-1500);
  });
});
