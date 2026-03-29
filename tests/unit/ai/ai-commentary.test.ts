/**
 * TDD: AI Management Commentary
 */

import { describe, it, expect } from 'vitest';
import {
  identifyKeyDrivers,
  assessRiskAreas,
  buildExecutiveSummary,
  type ManagementPackData,
  type KeyDriver,
} from '@/modules/accounting/services/aiCommentaryService';

const data: ManagementPackData = {
  companyName: 'ISAFlow Demo', period: 'March 2026',
  incomeStatement: { revenue: 217391, costOfSales: 119783, grossProfit: 97608, operatingExpenses: 18696, netProfit: 78913 },
  balanceSheet: { totalAssets: 462587, totalLiabilities: 160196, equity: 302391, currentRatio: 2.88, debtEquityRatio: 0.53 },
  priorPeriod: { revenue: 195652, costOfSales: 110000, grossProfit: 85652, operatingExpenses: 15000, netProfit: 70652 },
  ratios: { grossMargin: 44.9, netMargin: 36.3, currentRatio: 2.88, quickRatio: 2.88 },
};

describe('Key Driver Identification', () => {
  it('identifies revenue change as key driver', () => {
    const drivers = identifyKeyDrivers(data.incomeStatement, data.priorPeriod!);
    expect(drivers.some(d => d.metric === 'revenue')).toBe(true);
  });

  it('identifies cost of sales change', () => {
    const drivers = identifyKeyDrivers(data.incomeStatement, data.priorPeriod!);
    expect(drivers.some(d => d.metric === 'costOfSales')).toBe(true);
  });

  it('sorts by absolute impact descending', () => {
    const drivers = identifyKeyDrivers(data.incomeStatement, data.priorPeriod!);
    for (let i = 1; i < drivers.length; i++) {
      expect(Math.abs(drivers[i - 1]!.change)).toBeGreaterThanOrEqual(Math.abs(drivers[i]!.change));
    }
  });

  it('calculates percentage changes correctly', () => {
    const drivers = identifyKeyDrivers(data.incomeStatement, data.priorPeriod!);
    const revDriver = drivers.find(d => d.metric === 'revenue')!;
    expect(revDriver.changePercent).toBeCloseTo(11.1, 0);
  });

  it('flags direction as up or down', () => {
    const drivers = identifyKeyDrivers(data.incomeStatement, data.priorPeriod!);
    drivers.forEach(d => expect(['up', 'down', 'flat']).toContain(d.direction));
  });
});

describe('Risk Area Assessment', () => {
  it('flags low current ratio as high risk', () => {
    const risks = assessRiskAreas({ ...data, balanceSheet: { ...data.balanceSheet, currentRatio: 0.8 } });
    expect(risks.some(r => r.area.includes('Liquidity') && r.severity === 'high')).toBe(true);
  });

  it('flags high debt-to-equity as medium risk', () => {
    const risks = assessRiskAreas({ ...data, balanceSheet: { ...data.balanceSheet, debtEquityRatio: 2.5 } });
    expect(risks.some(r => r.area.includes('Leverage') && r.severity === 'medium')).toBe(true);
  });

  it('returns empty when ratios are healthy', () => {
    const risks = assessRiskAreas(data);
    const highRisks = risks.filter(r => r.severity === 'high');
    expect(highRisks.length).toBe(0);
  });
});

describe('Executive Summary Generation', () => {
  it('includes profit direction', () => {
    const summary = buildExecutiveSummary(data);
    expect(summary.profitDirection).toBe('up');
  });

  it('includes revenue growth', () => {
    const summary = buildExecutiveSummary(data);
    expect(summary.revenueGrowthPercent).toBeCloseTo(11.1, 0);
  });

  it('includes margin changes', () => {
    const summary = buildExecutiveSummary(data);
    expect(typeof summary.grossMarginPercent).toBe('number');
  });
});
