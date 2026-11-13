/**
 * I1–I4 on hand fixtures, I6 (derive-then-flat keeps AR/AP/Inv constant), I3 on
 * a capex month (M4: depreciation must never touch cash), opening refusal.
 */
import { describe, it, expect } from 'vitest';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { derivedDays } from '@/modules/accounting/services/budgets/threeWay/daysMethod';
import { OpeningUnbalancedError } from '@/modules/accounting/services/budgets/threeWay/errors';
import { daysInMonth } from '@/modules/accounting/services/budgets/threeWay/months';
import { assumptions, buckets, input, lookbackMonths, monthsFrom, pnl, R } from './helpers';
import { assertInvariants } from './invariants';

describe('I3 direct operating = indirect operating with capex and depreciation', () => {
  const months = monthsFrom('2026-04', 3);
  const inp = input({
    months,
    pnl: months.map(() => pnl({ turnover: 50000, costOfSales: 20000, otherOpex: 8000, payroll: 10000, depreciation: 3000, financeCost: 500, taxExpense: 2000 })),
    lookback: lookbackMonths('2025-04', Array.from({ length: 12 }, () => ({ turnover: 40000, costOfSales: 18000, supplierPurchases: 25000 }))),
    opening: buckets({ cash: 50000, receivables: 40000, inventory: 15000, payables: -20000, payrollLiabilities: -3000, fixedAssets: 90000, accumDepreciation: -10000, otherEquity: -162000 }),
    assumptions: assumptions(months, { debtorDays: 40, creditorDays: 25, inventoryDays: 22, statutoryShare: 0.25, vat: { cadence: 'bi-monthly', alignment: 'even' } }, a => {
      a.capex = [{ id: 'c', month: '2026-05', amountExVat: R(30000), vatClaimable: true, description: 'Kit' }];
    }),
  });
  it('holds every month (I1–I4)', () => {
    const out = runThreeWay(inp);
    assertInvariants(inp, out);
    expect(out.months[1]?.cashFlow.investing).toBe(-R(34500));
    expect(out.months.map(m => m.cashFlow.indirect.depreciation)).toEqual([R(3000), R(3000), R(3000)]);
  });
});

describe('I6 derive-then-flat: a daily-flat P&L keeps AR, AP and inventory constant', () => {
  const months = monthsFrom('2026-03', 12);
  const lbMonths = monthsFrom('2025-03', 12);
  const perDay = { turnover: 1000, costOfSales: 600, otherOpex: 200 };
  const lookback = lookbackMonths('2025-03', lbMonths.map(m => ({
    turnover: perDay.turnover * daysInMonth(m), costOfSales: perDay.costOfSales * daysInMonth(m),
    supplierPurchases: (perDay.costOfSales + perDay.otherOpex) * daysInMonth(m),
  })));
  const lbDays = lbMonths.map(daysInMonth);
  const open = { receivables: 1150 * 45, payables: -(920 * 30), inventory: 600 * 20 };
  // The pure derive: balance ÷ trailing VAT-inclusive flow × trailing days.
  const D = derivedDays(R(open.receivables), lookback.map(l => Math.round(l.turnover * 1.15)), lbDays);
  const C = derivedDays(R(-open.payables), lookback.map(l => Math.round(l.supplierPurchases * 1.15)), lbDays);
  const I = derivedDays(R(open.inventory), lookback.map(l => l.costOfSales), lbDays);
  it('derives 45 / 30 / 20 days', () => expect([D, C, I]).toEqual([45, 30, 20]));
  it('and the projection keeps the balances flat', () => {
    const inp = input({
      months,
      pnl: months.map(m => pnl({
        turnover: perDay.turnover * daysInMonth(m), costOfSales: perDay.costOfSales * daysInMonth(m), otherOpex: perDay.otherOpex * daysInMonth(m),
      })),
      lookback,
      opening: buckets({ cash: 100000, ...open, otherEquity: -(100000 + open.receivables + open.payables + open.inventory) }),
      assumptions: assumptions(months, { debtorDays: D ?? -1, creditorDays: C ?? -1, inventoryDays: I ?? -1, vat: { cadence: 'monthly' } }),
    });
    const out = runThreeWay(inp);
    assertInvariants(inp, out);
    for (const m of out.months) {
      expect([m.month, m.closing.receivables, m.closing.payables, m.closing.inventory])
        .toEqual([m.month, R(open.receivables), R(open.payables), R(open.inventory)]);
    }
  });
});

describe('opening must balance', () => {
  const months = monthsFrom('2026-03', 1);
  const base = { months, pnl: [pnl({})], assumptions: assumptions(months) };
  it('> 1 cent → OpeningUnbalancedError, no plug', () => {
    const inp = input({ ...base, opening: { ...buckets({ cash: 100 }), otherEquity: -9998 } });
    expect(() => runThreeWay(inp)).toThrow(OpeningUnbalancedError);
    try { runThreeWay(inp); } catch (e) { expect((e as OpeningUnbalancedError).differenceCents).toBe(2); }
  });
  it('exactly 1 cent: carried to retained earnings and warned, so check stays 0', () => {
    const out = runThreeWay(input({ ...base, opening: { ...buckets({ cash: 100 }), otherEquity: -9999 } }));
    expect(out.warnings).toContainEqual({ code: 'opening_cent_difference', cents: 1 });
    expect(out.opening.balanceSheet.check).toBe(0);
    expect(out.months[0]?.balanceSheet.check).toBe(0);
  });
});

describe('warnings', () => {
  it('negative cash is shown, never funded; runway finds the first month below minimum', () => {
    const months = monthsFrom('2026-03', 3);
    const out = runThreeWay(input({
      months, pnl: months.map(() => pnl({ otherOpex: 400 })),
      opening: buckets({ cash: 1000, otherEquity: -1000 }),
      assumptions: assumptions(months, {}, a => { a.minimumCash = { value: R(500), source: 'manual' }; }),
    }));
    expect(out.months.map(m => m.closing.cash)).toEqual([R(600), R(200), -R(200)]);
    expect(out.warnings).toContainEqual({ code: 'negative_cash', months: ['2026-05'] });
    expect(out.runway).toEqual({ minimumCash: R(500), firstBelowMinimum: '2026-04', minCash: -R(200), minCashMonth: '2026-05' });
  });
  it('10c: depreciation / interest checks > 5 % apart warn; entries outside the months warn', () => {
    const months = monthsFrom('2026-03', 2);
    const out = runThreeWay(input({
      months, pnl: months.map(() => pnl({ depreciation: 1000, financeCost: 100 })),
      opening: buckets({ cash: 10000, fixedAssets: 5000, loans: -5000, otherEquity: -10000 }),
      assumptions: assumptions(months, {}, a => {
        a.loans.existing = [{ loanId: 'L1', include: true }, { loanId: 'L2', include: true }];
        a.capex = [{ id: 'late', month: '2027-01', amountExVat: R(10), vatClaimable: false, description: '' }];
      }),
      loanSchedules: [{ loanId: 'L1', lines: months.map(m => ({ month: m, principal: 0, interest: R(106) })) }],
      checks: { assetRegisterDepreciation: [R(1050), R(1050)] },
    }));
    expect(out.warnings).toContainEqual({ code: 'interest_check', budgeted: R(200), check: R(212) });
    expect(out.warnings.some(w => w.code === 'depreciation_check')).toBe(false);
    expect(out.warnings).toContainEqual({ code: 'loan_schedule_missing', loanIds: ['L2'] });
    expect(out.warnings).toContainEqual({ code: 'outside_months', entries: [{ list: 'capex', id: 'late', skipped: 'entry', detail: 'capex late dated 2027-01, outside 2026-03..2026-04: skipped' }] });
  });
});
