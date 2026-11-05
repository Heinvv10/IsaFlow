/**
 * Which account may take payroll net pay instead of the bank (the
 * `payroll_net_pay` Default Accounts setting). One pure rule, used by the save
 * (defaultAccountsService), the page's options (roleCandidates) and the plan's
 * resolver (payrollJournalBank), so the three cannot disagree.
 *
 * An ALLOW-LIST (ledger review 2026-11-05): an active leaf liability whose subtype is payroll_liability once the
 * vocabulary's spellings are normalised, and not a conflict code. Every other subtype is refused, walked over the
 * WHOLE vocabulary below rather than a list of the ones the review happened to try.
 */
import { describe, it, expect } from 'vitest';
import {
  NET_PAY_CONFLICT_CODES, netPayCandidates, netPayTargetRefusal, type NetPayTargetAccount,
} from '@/modules/accounting/services/gl/netPayTargetRules';
import { PAYROLL_NET_PAY_KEY } from '@/modules/accounting/services/gl/netPaySetting';
import { ALL_RAW_SUBTYPES, canonicalSubtype } from '@/modules/accounting/services/gl/accountSubtypes';
import { roleCandidates } from '@/modules/accounting/services/gl/defaultAccountRoles';
import { REQUIRED_PAYROLL_ACCOUNT_CODES, OPTIONAL_PAYROLL_ACCOUNT_CODES } from '@/modules/accounting/services/payroll/payrollJournalParts';

const acct = (over: Partial<NetPayTargetAccount> = {}): NetPayTargetAccount => ({
  code: '2170', type: 'liability', isActive: true, subtype: 'payroll_liability', hasChildren: false, ...over,
});

describe('netPayTargetRefusal', () => {
  it('accepts an active, leaf liability on the payroll_liability subtype (Velocity 2170)', () => {
    expect(netPayTargetRefusal(acct())).toBeNull();
  });

  it.each(['payroll_liability', 'payroll_liabilities', 'Payroll Liability', ' payroll-liability '])('accepts the spelling %j', (subtype) => {
    expect(canonicalSubtype(subtype)).toBe('payroll_liability');
    expect(netPayTargetRefusal(acct({ subtype }))).toBeNull();
  });

  it.each([null, '', 'other', 'current_liability', 'other_current_liability', 'tax', 'unknown_importer_token'])(
    'refuses the subtype %j: it is not on the allow-list', (subtype) => {
      expect(netPayTargetRefusal(acct({ subtype }))).toMatchObject({ code: 'not_payroll_liability_net_pay_account' });
    });

  it('refuses EVERY other spelling in the subtype vocabulary (walks the table, not a copy of it)', () => {
    const others = ALL_RAW_SUBTYPES.filter((raw) => canonicalSubtype(raw) !== 'payroll_liability');
    expect(others.length).toBeGreaterThan(20);
    for (const subtype of others) {
      expect(netPayTargetRefusal(acct({ code: '2999', subtype }))?.code, subtype).toBe('not_payroll_liability_net_pay_account');
    }
  });

  it('the refusal says which subtype it found and which one it wants', () => {
    expect(netPayTargetRefusal(acct({ subtype: 'tax' }))!.message).toMatch(/'tax'.*payroll_liability/);
    expect(netPayTargetRefusal(acct({ subtype: null }))!.message).toMatch(/no subtype.*payroll_liability/);
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

  it.each(['payable', 'vat_output', 'vat_input_late_claim', 'bank', 'receivable', 'accounts_payable', 'creditors', 'bank_account', 'credit_card',
    'long_term_liability', 'tax'])('refuses the subtype %s (system role, AP/bank spelling, loan, VAT201)', (subtype) => {
    expect(netPayTargetRefusal(acct({ code: '2999', subtype }))).toMatchObject({ code: 'not_payroll_liability_net_pay_account' });
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
    { id: 'a-head', accountCode: '2200', accountType: 'liability', accountSubtype: 'payroll_liability', isActive: true },
    { id: 'a-kid', accountCode: '2201', accountType: 'liability', accountSubtype: 'payroll_liability', isActive: true, parentAccountId: 'a-head' },
    { id: 'a-ap', accountCode: '2110', accountType: 'liability', accountSubtype: 'payable', isActive: true },
    { id: 'a-tax', accountCode: '2125', accountType: 'liability', accountSubtype: 'tax', isActive: true },
    { id: 'a-none', accountCode: '2300', accountType: 'liability', accountSubtype: null, isActive: true },
    { id: 'a-cp', accountCode: '2215', accountType: 'liability', accountSubtype: 'current_liability', isActive: true },
    { id: 'a-plural', accountCode: '2172', accountType: 'liability', accountSubtype: 'payroll_liabilities', isActive: true },
  ];

  it('netPayCandidates keeps only the allow-listed liabilities (leaf, active, payroll_liability, not a journal credit)', () => {
    expect(netPayCandidates(chart).map((a) => a.accountCode)).toEqual(['2170', '2201', '2172']);
  });

  it('keeps the account the page shows even when it would no longer pass, so the select still names it', () => {
    expect(netPayCandidates(chart, 'a-1110').map((a) => a.accountCode)).toEqual(['2170', '1110', '2201', '2172']);
  });

  it('roleCandidates routes the payroll_net_pay row through the same rule', () => {
    expect(PAYROLL_NET_PAY_KEY).toBe('payroll_net_pay');
    expect(roleCandidates(PAYROLL_NET_PAY_KEY, chart).map((a) => a.accountCode)).toEqual(['2170', '2201', '2172']);
  });

  it('offers exactly what the rule accepts, account by account', () => {
    const offered = new Set(netPayCandidates(chart).map((a) => a.id));
    const parents = new Set(chart.map((a) => (a as { parentAccountId?: string }).parentAccountId).filter(Boolean));
    for (const a of chart) {
      const refusal = netPayTargetRefusal({
        code: a.accountCode, type: a.accountType, isActive: a.isActive, subtype: a.accountSubtype, hasChildren: parents.has(a.id),
      });
      expect(offered.has(a.id), a.accountCode).toBe(refusal === null);
    }
  });
});
