/**
 * T4: payroll statutory split (paid m+1) and provisional tax (10b as corrected
 * in §13): IRP6 #1 = 50 % of FY tax in FY month 6 (only when the year has more
 * than 6 months), #2 = the balance in the last month, top-up of the opening
 * payable 7 months after a February prior year end, else 6, when inside.
 */
import { describe, it, expect } from 'vitest';
import {
  payrollSplit, provisionalTaxApplies, provisionalTaxSchedule, sarsTopUpOffset,
} from '@/modules/accounting/services/budgets/threeWay/statutorySchedule';
import { R, monthsFrom } from './helpers';

describe('payrollSplit', () => {
  it('statutory = round(p × payroll), net = the residual', () => {
    expect(payrollSplit(R(100000), 300000)).toEqual({ statutory: R(30000), net: R(70000) });
    expect(payrollSplit(333, 333333)).toEqual({ statutory: 111, net: 222 });
    expect(payrollSplit(R(100), 0)).toEqual({ statutory: 0, net: R(100) });
  });
});

describe('provisionalTaxApplies (§13.2)', () => {
  it('on for pty_ltd, ltd, cc, npc; off for the rest', () => {
    expect(['pty_ltd', 'ltd', 'cc', 'npc'].every(e => provisionalTaxApplies(e as 'cc'))).toBe(true);
    expect(['sole_proprietor', 'partnership', 'trust', 'other'].some(e => provisionalTaxApplies(e as 'cc'))).toBe(false);
  });
});

describe('sarsTopUpOffset', () => {
  it('7 after a February year end, else 6', () => {
    expect(sarsTopUpOffset('2026-02')).toBe(7);
    for (const m of ['2026-01', '2026-03', '2026-06', '2025-12']) expect(sarsTopUpOffset(m)).toBe(6);
  });
});

describe('provisionalTaxSchedule', () => {
  const tax = (n: number) => Array.from({ length: n }, () => R(12000));

  it('F6 Feb YE: Aug 72 000, Sep top-up 30 000, Feb 72 000', () => {
    const months = monthsFrom('2026-03', 12);
    expect(provisionalTaxSchedule({ months, taxExpense: tax(12), openingTaxPayable: R(30000), topUpOffset: 7 })).toEqual([
      { month: '2026-08', kind: 'irp6_first', amount: R(72000) },
      { month: '2026-09', kind: 'top_up', amount: R(30000) },
      { month: '2027-02', kind: 'irp6_second', amount: R(72000) },
    ]);
  });

  it('F6 non-Feb YE (FY Jul–Jun): top-up in Dec, the IRP6 #1 month', () => {
    const months = monthsFrom('2026-07', 12);
    expect(provisionalTaxSchedule({ months, taxExpense: tax(12), openingTaxPayable: R(30000), topUpOffset: 6 })).toEqual([
      { month: '2026-12', kind: 'irp6_first', amount: R(72000) },
      { month: '2026-12', kind: 'top_up', amount: R(30000) },
      { month: '2027-06', kind: 'irp6_second', amount: R(72000) },
    ]);
  });

  it('14-month transition year: #1 in month 6, #2 (balance) in month 14', () => {
    const months = monthsFrom('2026-03', 14);
    const t = Array.from({ length: 14 }, () => 1001);
    const ev = provisionalTaxSchedule({ months, taxExpense: t, openingTaxPayable: 0, topUpOffset: 7 });
    expect(ev).toEqual([
      { month: '2026-08', kind: 'irp6_first', amount: 7007 },
      { month: '2027-04', kind: 'irp6_second', amount: 7007 },
    ]);
  });

  it('odd cents: #2 is the residue so #1 + #2 = FY tax', () => {
    const months = monthsFrom('2026-03', 12);
    const t = Array.from({ length: 12 }, (_, i) => (i === 0 ? 1 : 0));
    const ev = provisionalTaxSchedule({ months, taxExpense: t, openingTaxPayable: 0, topUpOffset: 7 });
    expect(ev.reduce((s, e) => s + e.amount, 0)).toBe(1);
  });

  it('6-month year or shorter: no #1, the whole FY tax in the last month', () => {
    for (const n of [1, 5, 6]) {
      const months = monthsFrom('2026-03', n);
      expect(provisionalTaxSchedule({ months, taxExpense: tax(n), openingTaxPayable: 0, topUpOffset: 7 }))
        .toEqual([{ month: months[n - 1], kind: 'irp6_second', amount: R(12000 * n) }]);
    }
  });

  it('7-month year: #1 in month 6', () => {
    const months = monthsFrom('2026-03', 7);
    const ev = provisionalTaxSchedule({ months, taxExpense: tax(7), openingTaxPayable: 0, topUpOffset: 7 });
    expect(ev.map(e => [e.month, e.kind, e.amount])).toEqual([
      ['2026-08', 'irp6_first', R(42000)], ['2026-09', 'irp6_second', R(42000)],
    ]);
  });

  it('top-up outside the version is not scheduled; a debit opening is never "paid"', () => {
    const months = monthsFrom('2026-03', 3);
    expect(provisionalTaxSchedule({ months, taxExpense: [0, 0, 0], openingTaxPayable: R(30000), topUpOffset: 7 })).toEqual([]);
    const full = monthsFrom('2026-03', 12);
    expect(provisionalTaxSchedule({ months: full, taxExpense: tax(12).map(() => 0), openingTaxPayable: -R(500), topUpOffset: 7 }))
      .toEqual([]);
  });

  it('a budgeted FY loss pays no provisional tax', () => {
    const months = monthsFrom('2026-03', 12);
    expect(provisionalTaxSchedule({ months, taxExpense: tax(12).map(v => -v), openingTaxPayable: 0, topUpOffset: 7 })).toEqual([]);
  });
});
