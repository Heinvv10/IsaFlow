/**
 * TDD: Waterfall Data Builder
 * Tests for profit, cash flow, and variance waterfall chart data.
 */

import { describe, it, expect } from 'vitest';
import {
  buildProfitWaterfall,
  buildCashFlowWaterfall,
  buildVarianceWaterfall,
  type WaterfallStep,
} from '@/modules/accounting/services/reports/waterfallDataService';

describe('Profit Waterfall', () => {
  it('builds correct steps from Revenue to Net Profit', () => {
    const steps = buildProfitWaterfall({
      revenue: 1000000,
      costOfSales: 600000,
      grossProfit: 400000,
      operatingExpenses: 200000,
      otherIncome: 10000,
      otherExpenses: 5000,
      netProfit: 205000,
    });
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(steps[0]!.label).toBe('Revenue');
    expect(steps[0]!.value).toBe(1000000);
    const gpStep = steps.find(s => s.label === 'Gross Profit');
    expect(gpStep).toBeDefined();
    expect(gpStep!.isSubtotal).toBe(true);
    expect(gpStep!.value).toBe(400000);
    const npStep = steps.find(s => s.label === 'Net Profit');
    expect(npStep).toBeDefined();
    expect(npStep!.isSubtotal).toBe(true);
  });

  it('marks subtotal bars correctly', () => {
    const steps = buildProfitWaterfall({
      revenue: 500000, costOfSales: 300000, grossProfit: 200000,
      operatingExpenses: 100000, otherIncome: 0, otherExpenses: 0, netProfit: 100000,
    });
    const subtotals = steps.filter(s => s.isSubtotal);
    expect(subtotals.length).toBeGreaterThanOrEqual(2); // Gross Profit + Net Profit
  });

  it('handles loss scenario (negative net profit)', () => {
    const steps = buildProfitWaterfall({
      revenue: 200000, costOfSales: 250000, grossProfit: -50000,
      operatingExpenses: 100000, otherIncome: 0, otherExpenses: 0, netProfit: -150000,
    });
    const np = steps.find(s => s.label === 'Net Profit')!;
    expect(np.value).toBeLessThan(0);
  });

  it('handles zero values', () => {
    const steps = buildProfitWaterfall({
      revenue: 0, costOfSales: 0, grossProfit: 0,
      operatingExpenses: 0, otherIncome: 0, otherExpenses: 0, netProfit: 0,
    });
    expect(steps.length).toBeGreaterThan(0);
    steps.forEach(s => expect(typeof s.value).toBe('number'));
  });
});

describe('Cash Flow Waterfall', () => {
  it('builds steps from Opening to Closing balance', () => {
    const steps = buildCashFlowWaterfall({
      opening: 100000,
      operatingIn: 300000,
      operatingOut: -200000,
      investingNet: -50000,
      financingNet: 20000,
      closing: 170000,
    });
    expect(steps[0]!.label).toBe('Opening Balance');
    expect(steps[0]!.value).toBe(100000);
    const closing = steps.find(s => s.label === 'Closing Balance');
    expect(closing).toBeDefined();
    expect(closing!.value).toBe(170000);
    expect(closing!.isSubtotal).toBe(true);
  });

  it('each step has start, end, value', () => {
    const steps = buildCashFlowWaterfall({
      opening: 50000, operatingIn: 100000, operatingOut: -60000,
      investingNet: -10000, financingNet: 0, closing: 80000,
    });
    steps.forEach(s => {
      expect(typeof s.start).toBe('number');
      expect(typeof s.end).toBe('number');
      expect(typeof s.value).toBe('number');
    });
  });
});

describe('Variance Waterfall', () => {
  it('builds steps from Budget through variances to Actual', () => {
    const steps = buildVarianceWaterfall([
      { label: 'Revenue', budgetAmount: 500000, actualAmount: 520000 },
      { label: 'Labour', budgetAmount: 200000, actualAmount: 210000 },
      { label: 'Materials', budgetAmount: 100000, actualAmount: 90000 },
    ]);
    expect(steps[0]!.label).toBe('Budget Total');
    const actual = steps.find(s => s.label === 'Actual Total');
    expect(actual).toBeDefined();
    expect(actual!.isSubtotal).toBe(true);
  });

  it('shows positive and negative variances', () => {
    const steps = buildVarianceWaterfall([
      { label: 'Revenue', budgetAmount: 100000, actualAmount: 120000 },
      { label: 'Costs', budgetAmount: 50000, actualAmount: 40000 },
    ]);
    const varSteps = steps.filter(s => !s.isSubtotal && s.label !== 'Budget Total');
    expect(varSteps.some(s => s.value > 0)).toBe(true);  // Revenue +20K
    expect(varSteps.some(s => s.value < 0)).toBe(true);   // Costs -10K
  });
});

describe('buildProfitWaterfall on either sign of revenue', () => {
  // Both cases measured against isaflow_dev for 2026-03-01..2026-08-31.
  // aggregateFigures signs revenue credit-less-debit and every expense band
  // debit-less-credit, so neither is guaranteed positive and this builder
  // must not force one.
  it('draws revenue up and operating expenses down for a positive-revenue company', () => {
    // ISAFlow Demo's own figures.
    const steps = buildProfitWaterfall({
      revenue: 71_600, costOfSales: 236_820.13, grossProfit: -165_220.13,
      operatingExpenses: 162_667.33, otherIncome: 9_770.68, otherExpenses: 0,
      netProfit: -318_116.78,
    });
    const rev = steps.find(s => s.label === 'Revenue')!;
    const opex = steps.find(s => s.label === 'Operating Expenses')!;
    expect(rev.start).toBe(0);
    expect(rev.end).toBeGreaterThan(rev.start);
    expect(opex.end).toBeLessThan(opex.start);
  });

  it('draws revenue down and operating expenses up when the ledger says both are negative', () => {
    // Brightsphere's own figures: revenue accounts in net debit, expense
    // accounts in net credit. A falling revenue bar is the honest reading,
    // not a sign bug.
    const steps = buildProfitWaterfall({
      revenue: -5_535_000, costOfSales: 0, grossProfit: -5_535_000,
      operatingExpenses: -3_717_000, otherIncome: -1_000, otherExpenses: -411_237,
      netProfit: -1_407_763,
    });
    const rev = steps.find(s => s.label === 'Revenue')!;
    const opex = steps.find(s => s.label === 'Operating Expenses')!;
    expect(rev.end).toBe(-5_535_000);
    expect(rev.end).toBeLessThan(rev.start);
    expect(opex.start).toBe(-5_535_000);
    expect(opex.end).toBe(-1_818_000);
    expect(opex.end).toBeGreaterThan(opex.start);
  });

  it('always prints the service figure on the bar, never the bar height', () => {
    const steps = buildProfitWaterfall({
      revenue: -5_535_000, costOfSales: 0, grossProfit: -5_535_000,
      operatingExpenses: -3_717_000, otherIncome: 0, otherExpenses: 0,
      netProfit: -1_818_000,
    });
    expect(steps.find(s => s.label === 'Revenue')!.value).toBe(-5_535_000);
    expect(steps.find(s => s.label === 'Operating Expenses')!.value).toBe(3_717_000);
  });
});

/**
 * ONE RULE FOR A LINE WITH NOTHING IN IT, AT THE BUILDER RATHER THAN AT ONE
 * CALLER.
 *
 * The two "Other" bands carried a `!== 0` gate of their own and the other
 * three lines carried none, so a bridge dropped a nil Other Expenses and drew
 * a nil Cost of Sales. On the board pack that printed six bars for one
 * company and seven for another off the same statement; `reportPackService`
 * and `/api/accounting/reports-waterfall` were drawing the same split. The
 * rule belongs here, where every caller gets it.
 */
describe('a nil movement is not drawn, on any line', () => {
  const base = {
    revenue: 1_000_000, costOfSales: 400_000, grossProfit: 600_000,
    operatingExpenses: 200_000, otherIncome: 50_000, otherExpenses: 25_000,
    netProfit: 425_000,
  };
  const MOVEMENTS = ['Cost of Sales', 'Operating Expenses', 'Other Income', 'Other Expenses'] as const;

  it('draws every line that has a figure', () => {
    const labels = buildProfitWaterfall(base).map(s => s.label);
    for (const line of MOVEMENTS) expect(labels, `${line} has a figure and is not drawn`).toContain(line);
  });

  for (const line of MOVEMENTS) {
    const field = {
      'Cost of Sales': 'costOfSales', 'Operating Expenses': 'operatingExpenses',
      'Other Income': 'otherIncome', 'Other Expenses': 'otherExpenses',
    }[line];
    it(`drops ${line} when it is nil`, () => {
      // Gross profit and net profit are recomputed so the bridge still lands
      // where the statement says — a nil line changes what is DRAWN, never
      // what the subtotals are.
      const zeroed = { ...base, [field]: 0 };
      const grossProfit = zeroed.revenue - zeroed.costOfSales;
      const steps = buildProfitWaterfall({
        ...zeroed,
        grossProfit,
        netProfit: grossProfit - zeroed.operatingExpenses + zeroed.otherIncome - zeroed.otherExpenses,
      });
      expect(steps.map(s => s.label), `${line} is nil and still drawn`).not.toContain(line);
      // AND NOTHING ELSE WENT WITH IT.
      for (const other of MOVEMENTS.filter(l => l !== line)) {
        expect(steps.map(s => s.label), `${other} was dropped with ${line}`).toContain(other);
      }
    });
  }

  it('keeps a subtotal whatever its value', () => {
    // A company that made exactly nothing: every movement is nil and goes,
    // INCLUDING Revenue — the rule is about the line having a figure, not
    // about which line it is — and both subtotals stay, because they are
    // where the bridge lands rather than steps in it.
    const steps = buildProfitWaterfall({
      revenue: 0, costOfSales: 0, grossProfit: 0,
      operatingExpenses: 0, otherIncome: 0, otherExpenses: 0, netProfit: 0,
    });
    // THREE SUBTOTALS, because the walk passes through three: the statement
    // prints gross profit, operating profit and net profit, and the bridge
    // drew the first and the last until this round.
    expect(steps.map(s => s.label)).toEqual(['Gross Profit', 'Operating Profit', 'Net Profit']);
    expect(steps.filter(s => s.isSubtotal).map(s => s.label))
      .toEqual(['Gross Profit', 'Operating Profit', 'Net Profit']);
  });

  it('leaves the running total unbroken across a dropped line', () => {
    // The steps that remain must still chain: an omission that left a gap
    // would draw a bridge whose bars no longer meet.
    const steps = buildProfitWaterfall({ ...base, otherIncome: 0, netProfit: 375_000 });
    const movements = steps.filter(s => !s.isSubtotal);
    for (let i = 1; i < movements.length; i += 1) {
      expect(movements[i]!.start, `${movements[i]!.label} does not start where ${movements[i - 1]!.label} ended`)
        .toBeCloseTo(movements[i - 1]!.end, 6);
    }
  });
});
