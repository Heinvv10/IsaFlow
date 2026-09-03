/**
 * The chart of accounts as an object of audit, not a CRUD list.
 *
 * Brightsphere is running two charts of accounts on top of each other — an
 * imported Sage chart and the system chart laid over it — and nothing in the
 * API says so. The consequences are all downstream and all silent: two accounts
 * receive the postings one payables control should, so the cash flow reads
 * whichever it resolves and AP movement showed as R0. Velocity has eight
 * cost-of-sales accounts with NO SUBTYPE AT ALL, which is why they land in
 * operating expenses.
 *
 * The classification is a pure function over account rows so it can be
 * exercised without a database, and so the rules can be read.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyAccount,
  normaliseAccountName,
  summariseChart,
  type ChartAccount,
} from '@/modules/accounting/services/gl/chartOfAccountsHealth';

const acct = (over: Partial<ChartAccount>): ChartAccount => ({
  id: 'a1',
  accountCode: '1000',
  accountName: 'Bank',
  accountType: 'asset',
  accountSubtype: 'bank',
  isActive: true,
  isSystemAccount: false,
  importedFrom: null,
  postedLines: 10,
  balance: 100,
  ...over,
});

describe('classifyAccount', () => {
  it('reports an account with no subtype', () => {
    // Velocity's eight COS accounts. Every subtype-driven report misplaces them.
    const f = classifyAccount(acct({ accountSubtype: null }));
    expect(f).toContain('no_subtype');
  });

  it('reports a subtype that does not belong to the account type', () => {
    // Production carries vat_input on a LIABILITY. Every type-based rule
    // misreads it, and the VAT201 nearly dropped 356 lines because of it.
    expect(classifyAccount(acct({ accountType: 'liability', accountSubtype: 'vat_input' })))
      .toContain('subtype_does_not_fit_type');
  });

  it('does not report a subtype that does belong to its type', () => {
    expect(classifyAccount(acct({ accountType: 'asset', accountSubtype: 'vat_input' })))
      .not.toContain('subtype_does_not_fit_type');
  });

  it('reports an account that has never been posted to', () => {
    expect(classifyAccount(acct({ postedLines: 0, balance: 0 }))).toContain('never_posted');
  });

  it('does not report an unposted account as dormant-with-a-balance', () => {
    expect(classifyAccount(acct({ postedLines: 0, balance: 0 }))).not.toContain('inactive_with_balance');
  });

  it('reports a deactivated account that still carries a balance', () => {
    // Brightsphere 1121 Loan Account — Blitz Fibre, R130,000, dropped from a
    // Caseware export by an is_active filter and out of balance by exactly that.
    expect(classifyAccount(acct({ isActive: false, balance: 130000 })))
      .toContain('inactive_with_balance');
  });

  it('does not report a deactivated account with no balance — that is just tidy', () => {
    expect(classifyAccount(acct({ isActive: false, balance: 0, postedLines: 4 }))).toEqual([]);
  });

  it('reports a clean account as having nothing wrong with it', () => {
    expect(classifyAccount(acct({}))).toEqual([]);
  });
});

describe('normaliseAccountName — near-duplicate detection', () => {
  it('collapses case, punctuation and spacing', () => {
    expect(normaliseAccountName('Trade  Debtors Control')).toBe(normaliseAccountName('trade debtors-control'));
  });

  it('keeps genuinely different names apart', () => {
    expect(normaliseAccountName('Trade Debtors')).not.toBe(normaliseAccountName('Trade Creditors'));
  });
});

describe('summariseChart', () => {
  it('finds a duplicated account code', () => {
    const s = summariseChart([
      acct({ id: 'a', accountCode: '1120' }),
      acct({ id: 'b', accountCode: '1120' }),
    ]);
    expect(s.duplicateCodes).toHaveLength(1);
    expect(s.duplicateCodes[0]).toMatchObject({ key: '1120', accountIds: ['a', 'b'] });
  });

  it('reports no duplicate for a code or a name used once — a group of one is not a duplicate', () => {
    const s = summariseChart([
      acct({ id: 'a', accountCode: '1120', accountName: 'Accounts Receivable' }),
      acct({ id: 'b', accountCode: '2110', accountName: 'Accounts Payable' }),
    ]);
    expect(s.duplicateCodes).toEqual([]);
    expect(s.duplicateNames).toEqual([]);
  });

  it('finds two accounts that are the same account under different codes', () => {
    // 1101 "Trade Debtors Control" and 1120 "Accounts Receivable" are the real
    // pair; this pins the weaker but unambiguous case of the same NAME twice.
    const s = summariseChart([
      acct({ id: 'a', accountCode: '1101', accountName: 'Trade Debtors Control' }),
      acct({ id: 'b', accountCode: '1120', accountName: 'trade  debtors control' }),
    ]);
    expect(s.duplicateNames).toHaveLength(1);
    expect(s.duplicateNames[0]!.accountIds).toEqual(['a', 'b']);
  });

  /**
   * The finding the audit could not state in one call: a system chart laid over
   * an imported one. Brightsphere has both, and every resolver picks one.
   */
  it('reports two charts running on top of each other', () => {
    const s = summariseChart([
      acct({ id: 'a', accountCode: '2001', accountName: 'Trade Creditors Control', accountSubtype: 'payable', isSystemAccount: true }),
      acct({ id: 'b', accountCode: '34550639', accountName: 'Accounts Payable', accountSubtype: null, importedFrom: 'sage', postedLines: 2 }),
    ]);
    expect(s.overlaidCharts).toBe(true);
    expect(s.importedAccounts).toBe(1);
    expect(s.systemAccounts).toBe(1);
  });

  it('does not call a single-origin chart overlaid', () => {
    const s = summariseChart([
      acct({ id: 'a', isSystemAccount: true }),
      acct({ id: 'b', accountCode: '1001', isSystemAccount: true }),
    ]);
    expect(s.overlaidCharts).toBe(false);
  });

  it('counts every account with a finding, and every finding', () => {
    const s = summariseChart([
      acct({ id: 'a', accountSubtype: null }),
      acct({ id: 'b', accountCode: '1001', isActive: false, balance: 500, accountSubtype: null }),
      acct({ id: 'c', accountCode: '1002' }),
    ]);
    expect(s.accountsWithFindings).toBe(2);
    expect(s.findingCounts.no_subtype).toBe(2);
    expect(s.findingCounts.inactive_with_balance).toBe(1);
    expect(s.accountsTotal).toBe(3);
  });
});
