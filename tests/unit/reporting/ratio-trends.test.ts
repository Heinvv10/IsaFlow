/**
 * TDD: Ratio Trend Analysis
 * Tests for multi-period ratio tracking.
 */

import { describe, it, expect } from 'vitest';
import { calculateRatioTrends } from '@/modules/accounting/services/reports/ratioTrendService';
import type { FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';

const makeData = (revenue: number, netProfit: number, cash: number): FinancialData => ({
  revenue, costOfSales: revenue * 0.6, operatingExpenses: revenue * 0.15, netProfit,
  totalAssets: revenue * 2, totalLiabilities: revenue * 0.8, totalEquity: revenue * 1.2,
  currentAssets: revenue * 0.5, currentLiabilities: revenue * 0.3, inventory: revenue * 0.1,
  accountsReceivable: revenue * 0.2, accountsPayable: revenue * 0.15, cash,
});

const periods: FinancialData[] = [
  makeData(800000, 120000, 100000),
  makeData(900000, 150000, 120000),
  makeData(1000000, 200000, 150000),
  makeData(1100000, 220000, 170000),
  makeData(1050000, 190000, 160000),
  makeData(1200000, 260000, 200000),
];
const labels = ['Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026'];

describe('Ratio Trend Calculator', () => {
  it('computes ratios for multiple periods', () => {
    const trends = calculateRatioTrends(periods, labels);
    expect(Array.isArray(trends)).toBe(true);
    expect(trends.length).toBeGreaterThan(0);
    const gpm = trends.find(t => t.ratioName === 'grossProfitMargin');
    expect(gpm).toBeDefined();
    expect(gpm!.values.length).toBe(6);
  });

  it('calculates period-over-period change', () => {
    const trends = calculateRatioTrends(periods, labels);
    const gpm = trends.find(t => t.ratioName === 'grossProfitMargin')!;
    gpm.values.forEach(v => {
      expect(v.period).toBeDefined();
      expect(typeof v.value).toBe('number');
    });
    expect(typeof gpm.changePercent).toBe('number');
  });

  it('flags improving/declining/stable trends', () => {
    const trends = calculateRatioTrends(periods, labels);
    const gpm = trends.find(t => t.ratioName === 'grossProfitMargin')!;
    expect(['improving', 'declining', 'stable']).toContain(gpm.trend);
  });

  it('handles sparse periods', () => {
    const sparse = [periods[0]!, periods[2]!, periods[5]!];
    const sparseLabels = ['Jan', 'Mar', 'Jun'];
    const trends = calculateRatioTrends(sparse, sparseLabels);
    expect(trends[0]!.values.length).toBe(3);
  });

  it('supports different lookback windows', () => {
    const t3 = calculateRatioTrends(periods.slice(0, 3), labels.slice(0, 3));
    expect(t3[0]!.values.length).toBe(3);
    const t6 = calculateRatioTrends(periods, labels);
    expect(t6[0]!.values.length).toBe(6);
  });

  it('includes key ratio names', () => {
    const trends = calculateRatioTrends(periods, labels);
    const names = trends.map(t => t.ratioName);
    expect(names).toContain('grossProfitMargin');
    expect(names).toContain('currentRatio');
    expect(names).toContain('debtorDays');
    expect(names).toContain('returnOnEquity');
  });
});

/**
 * A TREND BETWEEN TWO POINTS NEEDS TWO POINTS. Where a ratio could not be
 * stated in a period the engine gives null, and the trend used to read that
 * null as 0 — "stable, 0%" for a margin that did not exist at either end, or
 * a percentage change measured from nothing.
 */
describe('a ratio that could not be stated in a period', () => {
  const trading = {
    revenue: 1_000_000, costOfSales: 600_000, operatingExpenses: 250_000, netProfit: 100_000,
    totalAssets: 2_000_000, totalLiabilities: 800_000, totalEquity: 1_200_000,
    currentAssets: 900_000, currentLiabilities: 450_000,
    inventory: 150_000, accountsReceivable: 200_000, accountsPayable: 120_000, cash: 300_000,
  };
  const noRevenue = { ...trading, revenue: 0 };
  const margin = (periods: Array<typeof trading>) =>
    calculateRatioTrends(periods, periods.map((_, i) => `P${i + 1}`)).find((t) => t.ratioName === 'grossProfitMargin')!;

  it('carries the missing point as null, not 0', () => {
    expect(margin([noRevenue, trading]).values.map((v) => v.value)).toEqual([null, 40]);
  });

  it('states no change and no direction where the first or the last point is missing', () => {
    for (const periods of [[noRevenue, trading], [trading, noRevenue], [noRevenue, noRevenue]]) {
      const trend = margin(periods);
      expect(trend.changePercent).toBeNull();
      expect(trend.trend).toBe('not_meaningful');
    }
  });

  it('still measures the change across a gap in the middle', () => {
    const trend = margin([trading, noRevenue, { ...trading, costOfSales: 500_000 }]);
    expect(trend.values.map((v) => v.value)).toEqual([40, null, 50]);
    expect(trend.changePercent).toBe(25);
    expect(trend.trend).toBe('improving');
  });
});
