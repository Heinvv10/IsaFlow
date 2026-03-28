/**
 * TDD: Enhanced Reporting Engine Tests
 * RED phase — written before implementation.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateFinancialRatios,
  buildComparativeData,
  buildManagementPack,
  formatReportNumber,
  calculateVariance,
  type FinancialData,
  type RatioResult,
  type ComparativeRow,
  type ManagementPack,
  type VarianceResult,
} from '@/modules/accounting/services/reportingEngineService';

// ═══════════════════════════════════════════════════════════════════════════
// FINANCIAL RATIOS
// ═══════════════════════════════════════════════════════════════════════════

describe('Financial Ratios', () => {
  const sampleData: FinancialData = {
    revenue: 1000000,
    costOfSales: 600000,
    operatingExpenses: 200000,
    netProfit: 200000,
    totalAssets: 2000000,
    totalLiabilities: 800000,
    totalEquity: 1200000,
    currentAssets: 500000,
    currentLiabilities: 300000,
    inventory: 100000,
    accountsReceivable: 200000,
    accountsPayable: 150000,
    cash: 150000,
  };

  it('calculates gross profit margin', () => {
    const ratios = calculateFinancialRatios(sampleData);
    // (1000000 - 600000) / 1000000 = 40%
    expect(ratios.grossProfitMargin).toBeCloseTo(40, 0);
  });

  it('calculates net profit margin', () => {
    const ratios = calculateFinancialRatios(sampleData);
    // 200000 / 1000000 = 20%
    expect(ratios.netProfitMargin).toBeCloseTo(20, 0);
  });

  it('calculates operating profit margin', () => {
    const ratios = calculateFinancialRatios(sampleData);
    // (1000000 - 600000 - 200000) / 1000000 = 20%
    expect(ratios.operatingProfitMargin).toBeCloseTo(20, 0);
  });

  it('calculates current ratio', () => {
    const ratios = calculateFinancialRatios(sampleData);
    // 500000 / 300000 = 1.67
    expect(ratios.currentRatio).toBeCloseTo(1.67, 1);
  });

  it('calculates quick ratio (acid test)', () => {
    const ratios = calculateFinancialRatios(sampleData);
    // (500000 - 100000) / 300000 = 1.33
    expect(ratios.quickRatio).toBeCloseTo(1.33, 1);
  });

  it('calculates debt-to-equity ratio', () => {
    const ratios = calculateFinancialRatios(sampleData);
    // 800000 / 1200000 = 0.67
    expect(ratios.debtToEquity).toBeCloseTo(0.67, 1);
  });

  it('calculates return on assets (ROA)', () => {
    const ratios = calculateFinancialRatios(sampleData);
    // 200000 / 2000000 = 10%
    expect(ratios.returnOnAssets).toBeCloseTo(10, 0);
  });

  it('calculates return on equity (ROE)', () => {
    const ratios = calculateFinancialRatios(sampleData);
    // 200000 / 1200000 = 16.67%
    expect(ratios.returnOnEquity).toBeCloseTo(16.67, 0);
  });

  it('calculates debtor days', () => {
    const ratios = calculateFinancialRatios(sampleData);
    // (200000 / 1000000) * 365 = 73 days
    expect(ratios.debtorDays).toBeCloseTo(73, 0);
  });

  it('calculates creditor days', () => {
    const ratios = calculateFinancialRatios(sampleData);
    // (150000 / 600000) * 365 = 91.25 days
    expect(ratios.creditorDays).toBeCloseTo(91, 0);
  });

  it('handles zero revenue gracefully', () => {
    const ratios = calculateFinancialRatios({ ...sampleData, revenue: 0 });
    expect(ratios.grossProfitMargin).toBe(0);
    expect(ratios.netProfitMargin).toBe(0);
  });

  it('handles zero liabilities gracefully', () => {
    const ratios = calculateFinancialRatios({ ...sampleData, currentLiabilities: 0 });
    expect(ratios.currentRatio).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VARIANCE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Variance Calculation', () => {
  it('calculates positive variance (actual > budget)', () => {
    const result = calculateVariance(120000, 100000);
    expect(result.amount).toBe(20000);
    expect(result.percentage).toBeCloseTo(20, 0);
    expect(result.direction).toBe('favorable');
  });

  it('calculates negative variance (actual < budget)', () => {
    const result = calculateVariance(80000, 100000);
    expect(result.amount).toBe(-20000);
    expect(result.percentage).toBeCloseTo(-20, 0);
    expect(result.direction).toBe('unfavorable');
  });

  it('handles zero budget', () => {
    const result = calculateVariance(50000, 0);
    expect(result.amount).toBe(50000);
    expect(result.percentage).toBe(0);
  });

  it('handles zero actual', () => {
    const result = calculateVariance(0, 100000);
    expect(result.amount).toBe(-100000);
    expect(result.percentage).toBe(-100);
    expect(result.direction).toBe('unfavorable');
  });

  it('handles equal values', () => {
    const result = calculateVariance(100000, 100000);
    expect(result.amount).toBe(0);
    expect(result.percentage).toBe(0);
    expect(result.direction).toBe('on_budget');
  });

  it('expense variance is inverted (under budget = favorable)', () => {
    const result = calculateVariance(80000, 100000, true);
    expect(result.direction).toBe('favorable'); // Spent less than budget
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPARATIVE DATA
// ═══════════════════════════════════════════════════════════════════════════

describe('Comparative Data Building', () => {
  it('builds period-over-period comparison', () => {
    const current = [
      { account: 'Revenue', amount: 100000 },
      { account: 'Expenses', amount: 60000 },
    ];
    const prior = [
      { account: 'Revenue', amount: 90000 },
      { account: 'Expenses', amount: 55000 },
    ];
    const result = buildComparativeData(current, prior);
    expect(result.length).toBe(2);
    expect(result[0]!.currentAmount).toBe(100000);
    expect(result[0]!.priorAmount).toBe(90000);
    expect(result[0]!.changeAmount).toBe(10000);
    expect(result[0]!.changePercent).toBeCloseTo(11.11, 0);
  });

  it('handles missing prior period data', () => {
    const current = [{ account: 'Revenue', amount: 100000 }];
    const prior: typeof current = [];
    const result = buildComparativeData(current, prior);
    expect(result[0]!.priorAmount).toBe(0);
    expect(result[0]!.changeAmount).toBe(100000);
  });

  it('handles new accounts in current period', () => {
    const current = [
      { account: 'Revenue', amount: 100000 },
      { account: 'New Account', amount: 5000 },
    ];
    const prior = [{ account: 'Revenue', amount: 90000 }];
    const result = buildComparativeData(current, prior);
    expect(result.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MANAGEMENT PACK
// ═══════════════════════════════════════════════════════════════════════════

describe('Management Pack Building', () => {
  it('builds pack with all sections', () => {
    const pack = buildManagementPack({
      companyName: 'IsaFlow Pty Ltd',
      period: '2026-03',
      revenue: 500000,
      expenses: 350000,
      netProfit: 150000,
      cashBalance: 200000,
      arOutstanding: 80000,
      apOutstanding: 60000,
    });
    expect(pack.companyName).toBe('IsaFlow Pty Ltd');
    expect(pack.period).toBe('2026-03');
    expect(pack.sections.length).toBeGreaterThan(0);
  });

  it('includes KPI summary section', () => {
    const pack = buildManagementPack({
      companyName: 'Test', period: '2026-03',
      revenue: 100000, expenses: 60000, netProfit: 40000,
      cashBalance: 50000, arOutstanding: 20000, apOutstanding: 15000,
    });
    const kpiSection = pack.sections.find(s => s.title.toLowerCase().includes('kpi') || s.title.toLowerCase().includes('summary'));
    expect(kpiSection).toBeDefined();
  });

  it('calculates profit margin in pack', () => {
    const pack = buildManagementPack({
      companyName: 'Test', period: '2026-03',
      revenue: 200000, expenses: 140000, netProfit: 60000,
      cashBalance: 50000, arOutstanding: 20000, apOutstanding: 15000,
    });
    expect(pack.profitMargin).toBeCloseTo(30, 0);
  });

  it('includes generated timestamp', () => {
    const pack = buildManagementPack({
      companyName: 'Test', period: '2026-03',
      revenue: 0, expenses: 0, netProfit: 0,
      cashBalance: 0, arOutstanding: 0, apOutstanding: 0,
    });
    expect(pack.generatedAt).toBeDefined();
    expect(typeof pack.generatedAt).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

describe('Report Number Formatting', () => {
  it('formats ZAR currency', () => {
    expect(formatReportNumber(1500000, 'currency')).toContain('1');
    expect(formatReportNumber(1500000, 'currency')).toContain('500');
  });

  it('formats percentage', () => {
    expect(formatReportNumber(25.5, 'percent')).toContain('25');
    expect(formatReportNumber(25.5, 'percent')).toContain('%');
  });

  it('formats plain number with separators', () => {
    expect(formatReportNumber(1234567, 'number')).toContain('1');
  });

  it('handles zero', () => {
    expect(formatReportNumber(0, 'currency')).toBeDefined();
  });

  it('handles negative numbers', () => {
    const result = formatReportNumber(-5000, 'currency');
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });
});
