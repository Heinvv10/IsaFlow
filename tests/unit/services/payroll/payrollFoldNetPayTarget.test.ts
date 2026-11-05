/**
 * Re-approving a reopened run whose journal is still in force, when net pay can
 * go to the bank OR to a clearing liability (the `payroll_net_pay` setting).
 *
 * The comparison folds the bank credit into one "bank role" bucket by its
 * description (payrollLabourComparison#foldNetPayBank). If the clearing line
 * reused that description, a journal that credited the bank and a plan that now
 * credits 2170 would fold to the same key, re-lock silently, and leave net pay
 * counted twice once the salary bank lines are allocated to 2170. So the two
 * descriptions differ, and a move between them is its own refusal:
 *
 *   posted  plan   result
 *   bank    bank   unchanged (the bank role may have moved)
 *   bank    2170   net_pay_target_changed
 *   2170    bank   net_pay_target_changed
 *   2170    2170   equal; re-locks, posts nothing
 */
import { describe, it, expect } from 'vitest';
import {
  comparableLines, foldNetPayBank, NET_PAY_CLEARING_DESCRIPTION, NET_PAY_DESCRIPTION, netPayTargetChanged, sameFigures,
  type FigureLine,
} from '@/modules/accounting/services/payroll/payrollLabourComparison';
import { netPayTargetChangeNote } from '@/modules/accounting/services/payroll/payrollNetPayTargetChange';

const BANK = 'aaaaaaaa-0000-0000-0000-000000000001';
const BANK_2 = 'aaaaaaaa-0000-0000-0000-000000000009';
const CLEAR = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLEAR_2 = 'bbbbbbbb-0000-0000-0000-000000000008';
const LABOUR = 'cccccccc-0000-0000-0000-000000000003';
const PAYE = 'dddddddd-0000-0000-0000-000000000004';

type L = FigureLine & { description: string };
const line = (glAccountId: string | null, debit: number, credit: number, description: string): L =>
  ({ glAccountId, debit, credit, cc1Id: null, description });
const lines = (target: string | null, description: string, net = 18_200): L[] => [
  line(LABOUR, 20_200, 0, 'Labour'), line(PAYE, 0, 2_000, 'PAYE'), line(target, 0, net, description),
];
const toBank = (id: string | null, net?: number) => lines(id, NET_PAY_DESCRIPTION, net);
const toClearing = (id: string | null, net?: number) => lines(id, NET_PAY_CLEARING_DESCRIPTION, net);

/** The gate's decision, composed the way payrollApprovalGate composes it. */
const decide = (plan: L[], posted: L[], perAccount = false): 'target_changed' | 'same' | 'different' => {
  if (netPayTargetChanged(plan, posted)) return 'target_changed';
  const folded = foldNetPayBank(plan, posted);
  return sameFigures(perAccount ? comparableLines(folded.plan, undefined, folded.posted) : folded, perAccount) ? 'same' : 'different';
};

describe('the two net-pay descriptions', () => {
  it('differ, or a bank journal and a clearing plan fold to one key', () => {
    expect(NET_PAY_CLEARING_DESCRIPTION).not.toBe(NET_PAY_DESCRIPTION);
    expect(NET_PAY_CLEARING_DESCRIPTION).toBe('Net pay — net salaries payable');
  });
});

describe.each([false, true])('§3 re-approval matrix (recalculated since posting: %s)', (perAccount) => {
  it('bank -> bank: unchanged, even when the bank role moved to another account', () => {
    expect(decide(toBank(BANK), toBank(BANK), perAccount)).toBe('same');
    expect(decide(toBank(BANK_2), toBank(BANK), perAccount)).toBe('same');
    expect(decide(toBank(null), toBank(BANK), perAccount)).toBe('same');
  });

  it('bank -> 2170: net_pay_target_changed, not a silent re-lock', () => {
    expect(decide(toClearing(CLEAR), toBank(BANK), perAccount)).toBe('target_changed');
  });

  it('2170 -> bank: net_pay_target_changed', () => {
    expect(decide(toBank(BANK), toClearing(CLEAR), perAccount)).toBe('target_changed');
  });

  it('2170 -> 2170: equal, re-locks', () => {
    expect(decide(toClearing(CLEAR), toClearing(CLEAR), perAccount)).toBe('same');
  });

  it('2170 -> a different clearing account: its own refusal, not "recalculated"', () => {
    expect(decide(toClearing(CLEAR_2), toClearing(CLEAR), perAccount)).toBe('target_changed');
  });

  it('a changed net amount on the same clearing account is still a plain difference', () => {
    expect(decide(toClearing(CLEAR, 18_300), toClearing(CLEAR), perAccount)).toBe('different');
  });

  it('a clearing plan whose account no longer resolves (dangling id) still reads as moved off the bank', () => {
    expect(decide(toClearing(null), toBank(BANK), perAccount)).toBe('target_changed');
  });
});

describe('what is not a target change', () => {
  it('a plan with no net-pay line (zero net) against either journal falls through to the ordinary comparison', () => {
    const none = lines(null, NET_PAY_DESCRIPTION, 0).filter((l) => l.credit !== 0 || l.debit !== 0);
    expect(netPayTargetChanged(none, toBank(BANK))).toBe(false);
    expect(netPayTargetChanged(none, toClearing(CLEAR))).toBe(false);
  });

  it('a posted journal without descriptions (before they were written) is not a target change', () => {
    const old = toBank(BANK).map((l) => ({ ...l, description: 'Payroll' }));
    expect(netPayTargetChanged(toClearing(CLEAR), old)).toBe(false);
  });
});

describe('the refusal names both sides and the way out', () => {
  const names = ['5200 Labour', '2140 PAYE', '1110 Bank - Primary'];
  it('bank -> clearing', () => {
    const plan = toClearing(CLEAR).map((l) => ({ ...l, accountCode: '2170', accountName: 'Net Salaries Payable' }));
    const note = netPayTargetChangeNote(plan, toBank(BANK), names, 'JE-0042');
    expect(note?.code).toBe('net_pay_target_changed');
    expect(note?.detail).toContain('1110 Bank - Primary');
    expect(note?.detail).toContain('2170 Net Salaries Payable');
    expect(note?.detail).toMatch(/reverse journal JE-0042: approving then posts a new journal to the account the setting names at that time/);
    expect(note?.detail).toMatch(/set Payroll net pay in Default Accounts back/);
  });

  it('clearing -> bank', () => {
    const plan = toBank(BANK).map((l) => ({ ...l, accountCode: '1110', accountName: 'Bank - Primary' }));
    const note = netPayTargetChangeNote(plan, toClearing(CLEAR), ['5200 Labour', '2140 PAYE', '2170 Net Salaries Payable'], 'JE-0042');
    expect(note?.detail).toContain('2170 Net Salaries Payable');
    expect(note?.detail).toContain('1110 Bank - Primary');
  });

  it('is null when nothing moved', () => {
    expect(netPayTargetChangeNote(toBank(BANK).map((l) => ({ ...l, accountCode: '', accountName: '' })), toBank(BANK), names, 'JE-1')).toBeNull();
  });
});
