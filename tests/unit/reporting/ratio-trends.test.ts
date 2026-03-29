/**
 * TDD: Ratio Trend Analysis
 * Tests for multi-period ratio tracking.
 */

import { describe, it, expect } from 'vitest';
import { calculateRatioTrends } from '@/modules/accounting/services/ratioTrendService';
import type { FinancialData } from '@/modules/accounting/services/reportingEngineService';

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
