/**
 * T5 hand-computed fixtures F6 (provisional tax, both year-end variants, as
 * corrected in §13) and F7 (capex, depreciation, loan), every bucket every month.
 */
import { describe, it, expect } from 'vitest';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { assumptions, buckets, expectMonth, input, monthsFrom, pnl, R } from './helpers';

function f6(first: string, entityType: 'pty_ltd' | 'sole_proprietor' = 'pty_ltd', forceProvisional = false) {
  const months = monthsFrom(first, 12);
  return runThreeWay(input({
    months, entityType,
    pnl: months.map(() => pnl({ taxExpense: 12000 })),
    opening: buckets({ cash: 300000, incomeTaxPayable: -30000, otherEquity: -270000 }),
    assumptions: assumptions(months, { entityType }, a => {
      if (forceProvisional) a.incomeTax.mode = { value: 'provisional', source: 'manual' };
    }),
  }));
}

/** Tax payable (credit, rands) and cash after each month, from the hand schedule. */
function walk(payments: Record<number, number>): Array<{ cash: number; tax: number }> {
  let cash = 300000; let tax = 30000;
  return Array.from({ length: 12 }, (_, i) => {
    tax += 12000 - (payments[i] ?? 0); cash -= payments[i] ?? 0;
    return { cash, tax };
  });
}

describe('F6 FY Mar–Feb, tax 12 000/month, opening payable 30 000, February year end', () => {
  const out = f6('2026-03');
  it('Aug (month 6) 72 000; Sep (7 months after the prior Feb YE) 30 000; Feb 72 000', () => {
    expect(out.taxEvents).toEqual([
      { month: '2026-08', kind: 'irp6_first', amount: R(72000) },
      { month: '2026-09', kind: 'top_up', amount: R(30000) },
      { month: '2027-02', kind: 'irp6_second', amount: R(72000) },
    ]);
    const hand = walk({ 5: 72000, 6: 30000, 11: 72000 });
    hand.forEach((h, i) => expectMonth(out, i, {
      cash: h.cash, incomeTaxPayable: -h.tax, otherEquity: -270000, retainedEarnings: 12000 * (i + 1),
    }));
    expect(out.months[11]?.closing.incomeTaxPayable).toBe(0);
    expect(out.months.map(m => m.cashFlow.direct.other_operating)).toEqual(
      [0, 0, 0, 0, 0, -R(72000), -R(30000), 0, 0, 0, 0, -R(72000)]);
  });
});

describe('F6 non-Feb year end (FY Jul–Jun)', () => {
  const out = f6('2026-07');
  it('top-up in Dec (6 months after the prior June YE), with IRP6 #1', () => {
    const hand = walk({ 5: 102000, 11: 72000 });
    hand.forEach((h, i) => expectMonth(out, i, {
      cash: h.cash, incomeTaxPayable: -h.tax, otherEquity: -270000, retainedEarnings: 12000 * (i + 1),
    }));
    expect(out.months[5]?.month).toBe('2026-12');
    expect(out.months[5]?.cashFlow.direct.other_operating).toBe(-R(102000));
  });
});

describe('F6 for a sole proprietor: provisional tax off (§13.2)', () => {
  it('defaults to off: no payments, the payable accrues', () => {
    const out = f6('2026-03', 'sole_proprietor');
    expect(out.taxEvents).toEqual([]);
    expectMonth(out, 11, { cash: 300000, incomeTaxPayable: -(30000 + 144000), otherEquity: -270000, retainedEarnings: 144000 });
    expect(out.warnings).toEqual([]);
  });
  it('mode forced to provisional still pays nothing, and warns', () => {
    const out = f6('2026-03', 'sole_proprietor', true);
    expect(out.taxEvents).toEqual([]);
    expect(out.months[11]?.closing.cash).toBe(R(300000));
    expect(out.warnings).toContainEqual({ code: 'provisional_tax_not_applicable', entityType: 'sole_proprietor' });
  });
});

describe('F7 capex, depreciation, loan', () => {
  const months = monthsFrom('2026-04', 3);
  const out = runThreeWay(input({
    months,
    pnl: [pnl({ depreciation: 2000 }), pnl({ depreciation: 2000, financeCost: 1000 }), pnl({ depreciation: 2000, financeCost: 1000 })],
    opening: buckets({ cash: 200000, otherEquity: -200000 }),
    assumptions: assumptions(months, { vat: { cadence: 'monthly' } }, a => {
      a.capex = [{ id: 'cx1', month: '2026-04', amountExVat: R(100000), vatClaimable: true, description: 'Truck' }];
      a.loans.planned = [{
        id: 'ln1', description: 'Truck loan', drawdownMonth: '2026-04', principal: R(100000),
        annualRatePct: 12, termMonths: 20, firstRepaymentMonth: '2026-05',
      }];
    }),
    loanSchedules: [{ loanId: 'ln1', lines: [
      { month: '2026-05', principal: R(5000), interest: R(1000) },
      { month: '2026-06', principal: R(5000), interest: R(1000) },
    ] }],
    checks: { assetRegisterDepreciation: [R(2000), R(2000), R(2000)] },
  }));
  it('Apr: cash 115 000 out for capex, 15 000 VAT asset, 100 000 drawn', () => {
    expectMonth(out, 0, {
      cash: 185000, vatControl: 15000, fixedAssets: 100000, accumDepreciation: -2000,
      loans: -100000, otherEquity: -200000, retainedEarnings: 2000,
    });
    expectMonth(out, 1, {
      cash: 194000, fixedAssets: 100000, accumDepreciation: -4000, loans: -95000, otherEquity: -200000, retainedEarnings: 5000,
    });
    expectMonth(out, 2, {
      cash: 188000, fixedAssets: 100000, accumDepreciation: -6000, loans: -90000, otherEquity: -200000, retainedEarnings: 8000,
    });
  });
  it('investing −115 000 Apr; financing +100 000 Apr, −5 000 May; VAT refund May', () => {
    expect(out.months.map(m => m.cashFlow.investing)).toEqual([-R(115000), 0, 0]);
    expect(out.months.map(m => m.cashFlow.financing)).toEqual([R(100000), -R(5000), -R(5000)]);
    expect(out.months.map(m => m.cashFlow.operating)).toEqual([0, R(14000), -R(1000)]);
    expect(out.months.map(m => m.cashFlow.indirect.operating)).toEqual([0, R(14000), -R(1000)]);
    expect(out.months[0]?.cashFlow.indirect.vat).toBe(0);
  });
  it('10c checks agree within 5 %: no warning', () => {
    expect(out.warnings.filter(w => w.code === 'depreciation_check' || w.code === 'interest_check')).toEqual([]);
  });
});
