/**
 * T5 hand-computed fixtures F1–F5 (spec §10), every bucket every month to the cent.
 */
import { describe, it, expect } from 'vitest';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { assumptions, buckets, expectMonth, input, lookbackMonths, monthsFrom, pnl, R } from './helpers';

describe('F1 not VAT-registered, D = 15, C = 0', () => {
  const months = monthsFrom('2026-03', 3);
  const out = runThreeWay(input({
    months,
    pnl: [pnl({ turnover: 31000, otherOpex: 15500 }), pnl({ turnover: 30000, otherOpex: 15000 }), pnl({ turnover: 31000, otherOpex: 15500 })],
    opening: buckets({ cash: 100000, otherEquity: -100000 }),
    assumptions: assumptions(months, { debtorDays: 15 }),
  }));
  it('AR 15 000, cash 100 500 / 115 500 / 131 000, RE 15 500 / 30 500 / 46 000', () => {
    expectMonth(out, 0, { cash: 100500, receivables: 15000, otherEquity: -100000, retainedEarnings: -15500 });
    expectMonth(out, 1, { cash: 115500, receivables: 15000, otherEquity: -100000, retainedEarnings: -30500 });
    expectMonth(out, 2, { cash: 131000, receivables: 15000, otherEquity: -100000, retainedEarnings: -46000 });
  });
  it('receipts 16 000 / 30 000 / 31 000; BS 115 500 / 130 500 / 146 000 both sides', () => {
    expect(out.months.map(m => m.cashFlow.direct.cash_received_from_customers)).toEqual([R(16000), R(30000), R(31000)]);
    expect(out.months.map(m => m.balanceSheet.totalAssets)).toEqual([R(115500), R(130500), R(146000)]);
    expect(out.months.map(m => m.balanceSheet.totalLiabilities + m.balanceSheet.equity)).toEqual([R(115500), R(130500), R(146000)]);
  });
});

describe('F2 D = 45 walks into the lookback', () => {
  const months = monthsFrom('2026-03', 2);
  const out = runThreeWay(input({
    months,
    pnl: [pnl({ turnover: 31000 }), pnl({ turnover: 30000 })],
    lookback: lookbackMonths('2026-02', [{ turnover: 28000 }]),
    opening: buckets({ receivables: 45000, otherEquity: -45000 }),
    assumptions: assumptions(months, { debtorDays: 45 }),
  }));
  it('AR close Mar 45 000, Apr 45 000; receipts 31 000 / 30 000', () => {
    expectMonth(out, 0, { cash: 31000, receivables: 45000, otherEquity: -45000, retainedEarnings: -31000 });
    expectMonth(out, 1, { cash: 61000, receivables: 45000, otherEquity: -45000, retainedEarnings: -61000 });
    expect(out.warnings.filter(w => w.code === 'lookback_short')).toEqual([]);
  });
});

describe('F3 VAT monthly, invoice basis, shares 1', () => {
  const months = monthsFrom('2026-03', 2);
  const out = runThreeWay(input({
    months,
    pnl: [pnl({ turnover: 10000, otherOpex: 4000 }), pnl({})],
    opening: buckets({}),
    assumptions: assumptions(months, { vat: { cadence: 'monthly' } }),
  }));
  it('Mar: cash +6 900, VAT payable 900, RE 6 000; Apr: cash −900, VAT 0', () => {
    expectMonth(out, 0, { cash: 6900, vatControl: -900, retainedEarnings: -6000 });
    expectMonth(out, 1, { cash: 6000, vatControl: 0, retainedEarnings: -6000 });
    expect(out.months[1]?.cashFlow.direct.other_operating).toBe(-R(900));
    expect(out.vatSettlements).toEqual([{ periodStart: '2026-03', periodEnd: '2026-03', net: R(900), settleMonth: '2026-04', settled: true }]);
  });
});

describe('F3b bi-monthly Category A, period Apr–May, opening VAT payable 2 000 (period ended Mar)', () => {
  const months = monthsFrom('2026-04', 3);
  const base = {
    months,
    pnl: [pnl({ turnover: 10000 }), pnl({ turnover: 10000 }), pnl({})],
    lookback: lookbackMonths('2026-03', [{}]),
    opening: buckets({ cash: 2000, vatControl: -2000 }),
  };
  it('invoice basis: Apr pays 2 000; May accrues 3 000 total; June pays 3 000', () => {
    const out = runThreeWay(input({ ...base, assumptions: assumptions(months, { vat: { cadence: 'bi-monthly', alignment: 'odd' } }) }));
    expectMonth(out, 0, { cash: 11500, vatControl: -1500, retainedEarnings: -10000 });
    expectMonth(out, 1, { cash: 23000, vatControl: -3000, retainedEarnings: -20000 });
    expectMonth(out, 2, { cash: 20000, vatControl: 0, retainedEarnings: -20000 });
    expect(out.months.map(m => m.cashFlow.direct.other_operating)).toEqual([-R(2000), 0, -R(3000)]);
  });
  it('payment basis, D = 31: VAT accrues on receipts (May 1 500 due in June)', () => {
    const out = runThreeWay(input({
      ...base,
      assumptions: assumptions(months, { debtorDays: 31, vat: { cadence: 'bi-monthly', alignment: 'odd', basis: 'payment' } }),
    }));
    // Apr: AR 11 500 (31 d covers Apr's 30 + 1 lookback day of 0), receipts 0, pays 2 000.
    expectMonth(out, 0, { cash: 0, receivables: 11500, vatControl: -1500, retainedEarnings: -10000 });
    // May: receipts 11 500 (VAT inside 1 500), AR 11 500.
    expectMonth(out, 1, { cash: 11500, receivables: 11500, vatControl: -3000, retainedEarnings: -20000 });
    // Jun: AR = 1/31 × 11 500 = 370.97; receipts 11 129.03; pays Apr–May's 1 500.
    expectMonth(out, 2, { cash: 21129.03, receivables: 370.97, vatControl: -1500, retainedEarnings: -20000 });
    expect(out.vatSettlements.map(s => [s.periodStart, s.periodEnd, s.net, s.settleMonth, s.settled])).toEqual([
      ['2026-02', '2026-03', R(2000), '2026-04', true],
      ['2026-04', '2026-05', R(1500), '2026-06', true],
      ['2026-06', '2026-07', 145161, '2026-08', false],
    ]);
  });
});

describe('F4 payroll 100 000/month, p = 0.30, opening liability 25 000', () => {
  const months = monthsFrom('2026-03', 2);
  const out = runThreeWay(input({
    months,
    pnl: [pnl({ payroll: 100000 }), pnl({ payroll: 100000 })],
    opening: buckets({ cash: 300000, payrollLiabilities: -25000, otherEquity: -275000 }),
    assumptions: assumptions(months, { statutoryShare: 0.3 }),
  }));
  it('month 1 cash out 95 000, liability 30 000; month 2 out 100 000', () => {
    expect(out.months.map(m => m.cashFlow.direct.cash_paid_to_employees)).toEqual([-R(95000), -R(100000)]);
    expectMonth(out, 0, { cash: 205000, payrollLiabilities: -30000, otherEquity: -275000, retainedEarnings: 100000 });
    expectMonth(out, 1, { cash: 105000, payrollLiabilities: -30000, otherEquity: -275000, retainedEarnings: 200000 });
  });
});

describe('F5 COGS 60 000 (31-day month), I = 31, opening inventory 50 000, C = 0, no VAT', () => {
  const months = monthsFrom('2026-03', 1);
  const out = runThreeWay(input({
    months,
    pnl: [pnl({ costOfSales: 60000 })],
    lookback: lookbackMonths('2026-02', [{ costOfSales: 50000 }]),
    opening: buckets({ cash: 100000, inventory: 50000, otherEquity: -150000 }),
    assumptions: assumptions(months, { inventoryDays: 31 }),
  }));
  it('closing inventory 60 000; purchases paid 70 000', () => {
    expectMonth(out, 0, { cash: 30000, inventory: 60000, otherEquity: -150000, retainedEarnings: 60000 });
    expect(out.months[0]?.cashFlow.direct.cash_paid_to_suppliers).toBe(-R(70000));
  });
});
