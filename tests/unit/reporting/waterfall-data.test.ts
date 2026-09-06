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
