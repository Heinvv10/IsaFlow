/**
 * Fix round 1, behaviour (items 2, 3, 4, 6, 7, 9, 11, 12), every figure hand-computed.
 */
import { describe, it, expect } from 'vitest';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { mergeOverrides } from '@/modules/accounting/services/budgets/threeWay/assumptionsChain';
import { ThreeWayAssumptionsSchema } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import { AssumptionsDocError } from '@/modules/accounting/services/budgets/threeWay/errors';
import { vatInGross, vatOnNet } from '@/modules/accounting/services/budgets/threeWay/ratios';
import { assumptions, buckets, expectMonth, input, lookbackMonths, monthsFrom, pnl, R } from './helpers';
import { assertInvariants } from './invariants';

const m3 = monthsFrom('2026-03', 3);
const flat = () => m3.map(() => pnl({}));

describe('item 2: dividends', () => {
  it('declared before the version, paid inside: skipped whole, warned with what was skipped', () => {
    const a = assumptions(m3, {}, d => { d.equity.dividends = [{ id: 'd1', declaredMonth: '2026-01', paidMonth: '2026-04', amount: R(10000) }]; });
    const out = runThreeWay(input({ months: m3, pnl: flat(), opening: buckets({ cash: 50000, shareCapital: -50000 }), assumptions: a }));
    m3.forEach((_, i) => expectMonth(out, i, { cash: 50000, shareCapital: -50000 }));
    expect(out.warnings).toContainEqual({ code: 'outside_months', entries: [{
      list: 'equity.dividends', id: 'd1', skipped: 'entry',
      detail: 'dividend d1 declared 2026-01, before 2026-03..2026-05: skipped, and so is its payment in 2026-04 (a dividend declared before the version is in the opening dividends payable)',
    }] });
  });
  it('declared inside, paid after: the declaration posts and stays payable', () => {
    const a = assumptions(m3, {}, d => { d.equity.dividends = [{ id: 'd2', declaredMonth: '2026-04', paidMonth: '2026-07', amount: R(10000) }]; });
    const out = runThreeWay(input({ months: m3, pnl: flat(), opening: buckets({ cash: 50000, shareCapital: -50000 }), assumptions: a }));
    expectMonth(out, 0, { cash: 50000, shareCapital: -50000 });
    expectMonth(out, 2, { cash: 50000, shareCapital: -50000, dividendsPayable: -10000, retainedEarnings: 10000 });
    expect(out.warnings).toContainEqual({ code: 'outside_months', entries: [{
      list: 'equity.dividends', id: 'd2', skipped: 'payment', detail: 'dividend d2 paid 2026-07, after 2026-05: payment skipped, the declaration stays payable',
    }] });
  });
});

describe('item 3: a planned loan drawn outside the version is excluded whole', () => {
  it('no drawdown, no repayments, no missing-schedule warning', () => {
    const a = assumptions(m3, {}, d => { d.loans.planned = [{ id: 'L1', description: 'x', drawdownMonth: '2026-01', principal: R(100000), annualRatePct: 10, termMonths: 20, firstRepaymentMonth: '2026-02' }]; });
    const out = runThreeWay(input({ months: m3, pnl: flat(), opening: buckets({ cash: 50000, shareCapital: -50000 }), assumptions: a,
      loanSchedules: [{ loanId: 'L1', lines: m3.map(m => ({ month: m, principal: R(5000), interest: R(10) })) }] }));
    m3.forEach((_, i) => expectMonth(out, i, { cash: 50000, shareCapital: -50000 }));
    expect(out.warnings).toEqual([{ code: 'outside_months', entries: [{
      list: 'loans.planned', id: 'L1', skipped: 'entry', detail: 'planned loan L1 drawn 2026-01, outside 2026-03..2026-05: skipped with its repayments',
    }] }]);
  });
});

describe('item 4: topUpMonthOffset', () => {
  const ms = monthsFrom('2026-03', 12);
  const run = (value: 6 | 7, source: 'derived' | 'manual') => runThreeWay(input({
    months: ms, pnl: ms.map(() => pnl({ taxExpense: 12000 })),
    opening: buckets({ cash: 500000, incomeTaxPayable: -30000, shareCapital: -470000 }),
    assumptions: assumptions(ms, {}, d => { d.incomeTax.topUpMonthOffset = { value, source }; }),
  }));
  it('a derived value is recomputed from the year end (Feb YE → 7: Sep)', () => {
    const out = run(6, 'derived');
    expect(out.taxEvents.find(e => e.kind === 'top_up')?.month).toBe('2026-09');
    expect(out.warnings).toEqual([]);
  });
  it('a manual value is honoured, warned when it differs from SARS', () => {
    const out = run(6, 'manual');
    expect(out.taxEvents.find(e => e.kind === 'top_up')?.month).toBe('2026-08');
    expect(out.warnings).toEqual([{ code: 'top_up_offset_not_sars', value: 6, sars: 7 }]);
    expect(run(7, 'manual').warnings).toEqual([]);
  });
});

describe('item 6: day fields hold 2 decimals', () => {
  const withDays = (debtor: number, inventory = 0) => assumptions(m3, { debtorDays: debtor, inventoryDays: inventory });
  it('refuses 3 decimals, accepts 2', () => {
    for (const d of [30.125, 0.001, 364.999]) expect(ThreeWayAssumptionsSchema.safeParse(withDays(d)).success, `${d}`).toBe(false);
    for (const d of [30.12, 0.07, 364.99, 0.29]) expect(ThreeWayAssumptionsSchema.safeParse(withDays(d)).success, `${d}`).toBe(true);
    expect(ThreeWayAssumptionsSchema.safeParse(withDays(0, 729.99)).success).toBe(true);
    expect(ThreeWayAssumptionsSchema.safeParse(withDays(0, 729.999)).success).toBe(false);
  });
});

describe('item 7: debit openings are carried flat, never refunded', () => {
  it('payroll liabilities overpaid 5 000: no inflow; only the month\'s accrual is remitted', () => {
    const ms = monthsFrom('2026-03', 2);
    const out = runThreeWay(input({ months: ms, pnl: ms.map(() => pnl({ payroll: 10000 })),
      opening: buckets({ cash: 100000, payrollLiabilities: 5000, otherEquity: -105000 }), assumptions: assumptions(ms, { statutoryShare: 0.3 }) }));
    expectMonth(out, 0, { cash: 93000, payrollLiabilities: 2000, otherEquity: -105000, retainedEarnings: 10000 });
    expectMonth(out, 1, { cash: 83000, payrollLiabilities: 2000, otherEquity: -105000, retainedEarnings: 20000 });
    expect(out.warnings).toEqual([{ code: 'opening_debit_carried', bucket: 'payrollLiabilities', amount: R(5000) }]);
  });
  it('a debit income tax payable is warned the same way', () => {
    const out = runThreeWay(input({ months: m3, pnl: flat(), opening: buckets({ cash: 100, incomeTaxPayable: 2000, otherEquity: -2100 }), assumptions: assumptions(m3) }));
    expect(out.warnings).toEqual([{ code: 'opening_debit_carried', bucket: 'incomeTaxPayable', amount: R(2000) }]);
    expectMonth(out, 2, { cash: 100, incomeTaxPayable: 2000, otherEquity: -2100 });
  });
});

describe('item 9: negative residual flows are kept (balance holds) and warned', () => {
  it('opening inventory with zero inventory days: stock purchases and payments −40 000', () => {
    const ms = monthsFrom('2026-03', 1);
    const inp = input({ months: ms, pnl: [pnl({ costOfSales: 10000 })], opening: buckets({ inventory: 50000, otherEquity: -50000 }), assumptions: assumptions(ms) });
    const out = runThreeWay(inp);
    assertInvariants(inp, out);
    expectMonth(out, 0, { cash: 40000, otherEquity: -50000, retainedEarnings: 10000 });
    expect(out.warnings).toEqual([
      { code: 'negative_flow', month: '2026-03', flow: 'stock_purchases', amount: -R(40000) },
      { code: 'negative_flow', month: '2026-03', flow: 'supplier_payments', amount: -R(40000) },
    ]);
  });
  it('365 debtor days over a 1-month lookback: receipts −28 000, lookback_short, negative cash', () => {
    const ms = monthsFrom('2026-03', 1);
    const inp = input({ months: ms, pnl: [pnl({ turnover: 31000 })], lookback: lookbackMonths('2026-02', [{ turnover: 28000 }]),
      opening: buckets({}), assumptions: assumptions(ms, { debtorDays: 365 }) });
    const out = runThreeWay(inp);
    assertInvariants(inp, out);
    expectMonth(out, 0, { cash: -28000, receivables: 59000, retainedEarnings: -31000 });
    expect(out.warnings).toEqual([
      { code: 'negative_flow', month: '2026-03', flow: 'receipts', amount: -R(28000) },
      { code: 'lookback_short', series: 'receivables', months: ['2026-03'] },
      { code: 'negative_cash', months: ['2026-03'] },
    ]);
  });
});

describe('item 11: VAT gaps', () => {
  it('vatOnNet / vatInGross with share < 1 are exact inverses', () => {
    expect(vatOnNet(10000, 500000)).toBe(750); // 10 000 × 0.5 × 0.15
    expect(vatInGross(10750, 500000)).toBe(750); // 10 750 × 0.075 / 1.075
    expect(vatOnNet(1_000_000, 333333)).toBe(50000); // 49 999.95 → 50 000
    expect(vatInGross(1_050_000, 333333)).toBe(50000); // 1 050 000 × 0.04999995 / 1.04999995 = 49 999.998
  });
  it('refund lag 0: a March refund is received in March', () => {
    const ms = monthsFrom('2026-03', 2);
    const out = runThreeWay(input({ months: ms, pnl: [pnl({ otherOpex: 10000 }), pnl({})], opening: buckets({ cash: 20000, shareCapital: -20000 }),
      assumptions: assumptions(ms, { vat: { cadence: 'monthly' } }, d => { d.vat.refundLagMonths = { value: 0, source: 'manual' }; }) }));
    expect(out.vatSettlements).toEqual([{ periodStart: '2026-03', periodEnd: '2026-03', net: -R(1500), settleMonth: '2026-03', settled: true }]);
    expectMonth(out, 0, { cash: 10000, shareCapital: -20000, retainedEarnings: 10000 });
  });
  it('payment basis: opening VAT due excludes the VAT still inside opening AR', () => {
    // Opening VAT control 3 500 = 2 000 due (Feb) + 1 500 inside the opening AR of 11 500.
    const ms = monthsFrom('2026-03', 2);
    const out = runThreeWay(input({ months: ms, pnl: ms.map(() => pnl({})),
      opening: buckets({ receivables: 11500, vatControl: -3500, otherEquity: -8000 }),
      assumptions: assumptions(ms, { vat: { cadence: 'monthly', basis: 'payment' } }) }));
    expectMonth(out, 0, { cash: 9500, vatControl: -1500, otherEquity: -8000 });
    expectMonth(out, 1, { cash: 8000, otherEquity: -8000 });
    expect(out.vatSettlements.map(s => [s.periodEnd, s.net, s.settleMonth])).toEqual([['2026-02', R(2000), '2026-03'], ['2026-03', R(1500), '2026-04']]);
  });
});

describe('item 12: mergeOverrides refuses prototype keys itself', () => {
  const cases: Array<[string, string]> = [
    ['{"__proto__":{"polluted":1}}', '__proto__'], ['{"vat":{"constructor":{"x":1}}}', 'vat.constructor'],
    ['{"prototype":1}', 'prototype'], ['{"workingCapital":{"__proto__":{"x":1}}}', 'workingCapital.__proto__'],
  ];
  for (const [raw, path] of cases) {
    it(`refuses ${raw} before merging (issue path ${path})`, () => {
      try { mergeOverrides(assumptions(m3), JSON.parse(raw)); } catch (e) {
        expect(e).toBeInstanceOf(AssumptionsDocError);
        expect((e as AssumptionsDocError).issues).toEqual([{ path, message: 'Forbidden key' }]);
        expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
        return;
      }
      expect.fail('expected AssumptionsDocError');
    });
  }
});
