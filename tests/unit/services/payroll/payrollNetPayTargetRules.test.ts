/**
 * Which account may take payroll net pay instead of the bank (the
 * `payroll_net_pay` Default Accounts setting). One pure rule, used by the save
 * (defaultAccountsService), the page's options (roleCandidates) and the plan's
 * resolver (payrollJournalBank), so the three cannot disagree.
 */
import { describe, it, expect } from 'vitest';
import {
  NET_PAY_CONFLICT_CODES, PAYROLL_NET_PAY_KEY, netPayCandidates, netPayTargetRefusal, type NetPayTargetAccount,
} from '@/modules/accounting/services/payroll/payrollNetPayTargetRules';
import { roleCandidates } from '@/modules/accounting/services/gl/defaultAccountRoles';
import { REQUIRED_PAYROLL_ACCOUNT_CODES, OPTIONAL_PAYROLL_ACCOUNT_CODES } from '@/modules/accounting/services/payroll/payrollJournalParts';

const acct = (over: Partial<NetPayTargetAccount> = {}): NetPayTargetAccount => ({
  code: '2170', type: 'liability', isActive: true, subtype: 'payroll_liability', hasChildren: false, ...over,
});

describe('netPayTargetRefusal', () => {
  it('accepts an active, leaf liability on the payroll_liability subtype (Velocity 2170)', () => {
    expect(netPayTargetRefusal(acct())).toBeNull();
  });

  it.each([null, '', 'other', 'current_liability', 'other_current_liability', 'tax'])('accepts the subtype %j', (subtype) => {
    expect(netPayTargetRefusal(acct({ subtype }))).toBeNull();
  });

  it.each(['asset', 'equity', 'revenue', 'expense'])('refuses a %s account', (type) => {
    expect(netPayTargetRefusal(acct({ type }))).toMatchObject({ code: 'not_liability_net_pay_account' });
  });

  it('refuses an inactive account by default, and lets the plan judge it when asked', () => {
    expect(netPayTargetRefusal(acct({ isActive: false }))).toMatchObject({ code: 'inactive_net_pay_account' });
    expect(netPayTargetRefusal(acct({ isActive: false }), { allowInactive: true })).toBeNull();
  });

  it('refuses a header with sub-accounts, and ignores the question when the caller does not judge it', () => {
    expect(netPayTargetRefusal(acct({ hasChildren: true }))).toMatchObject({ code: 'header_net_pay_account' });
    const { hasChildren: _unjudged, ...undecided } = acct({ hasChildren: true });
    expect(netPayTargetRefusal(undecided)).toBeNull();
  });

  it.each(['2140', '2150', '2160', '2175'])('refuses %s: the journal already credits it for something else', (code) => {
    expect(netPayTargetRefusal(acct({ code }))).toMatchObject({ code: 'net_pay_account_conflict' });
  });

  it.each(['payable', 'vat_output', 'vat_input_late_claim', 'bank', 'receivable'])('refuses the system-role subtype %s', (subtype) => {
    expect(netPayTargetRefusal(acct({ code: '2999', subtype }))).toMatchObject({ code: 'net_pay_account_conflict' });
  });

  it('names the account and says why, in prose a person can act on', () => {
    expect(netPayTargetRefusal(acct({ code: '2140' }))!.message).toMatch(/2140/);
    expect(netPayTargetRefusal(acct({ type: 'asset', code: '1110' }))!.message).toMatch(/liability/);
  });
});

describe('the conflict list', () => {
  it('is every account the payroll journal credits besides net pay, and nothing else', () => {
    const credited = [...REQUIRED_PAYROLL_ACCOUNT_CODES, ...OPTIONAL_PAYROLL_ACCOUNT_CODES].filter((c) => c !== '5200');
    expect([...NET_PAY_CONFLICT_CODES].sort()).toEqual([...credited].sort());
  });
});

describe('the page offers exactly what the save accepts', () => {
  const chart = [
    { id: 'a-2170', accountCode: '2170', accountType: 'liability', accountSubtype: 'payroll_liability', isActive: true },
    { id: 'a-2140', accountCode: '2140', accountType: 'liability', accountSubtype: 'payroll_liability', isActive: true },
    { id: 'a-1110', accountCode: '1110', accountType: 'asset', accountSubtype: 'bank', isActive: true },
    { id: 'a-off', accountCode: '2171', accountType: 'liability', accountSubtype: 'payroll_liability', isActive: false },
    { id: 'a-head', accountCode: '2200', accountType: 'liability', accountSubtype: null, isActive: true },
    { id: 'a-kid', accountCode: '2210', accountType: 'liability', accountSubtype: null, isActive: true, parentAccountId: 'a-head' },
    { id: 'a-ap', accountCode: '2110', accountType: 'liability', accountSubtype: 'payable', isActive: true },
  ];

  it('netPayCandidates keeps only the acceptable liabilities (leaf, active, not a journal credit, not a role)', () => {
    expect(netPayCandidates(chart).map((a) => a.accountCode)).toEqual(['2170', '2210']);
  });

  it('keeps the account the page shows even when it would no longer pass, so the select still names it', () => {
    expect(netPayCandidates(chart, 'a-1110').map((a) => a.accountCode)).toEqual(['2170', '1110', '2210']);
  });

  it('roleCandidates routes the payroll_net_pay row through the same rule', () => {
    expect(PAYROLL_NET_PAY_KEY).toBe('payroll_net_pay');
    expect(roleCandidates(PAYROLL_NET_PAY_KEY, chart).map((a) => a.accountCode)).toEqual(['2170', '2210']);
  });
});
