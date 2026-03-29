/**
 * TDD: Extended Financial Ratios
 * Tests for 19 additional ratios beyond the original 11.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateExtendedRatios,
  type FinancialData,
} from '@/modules/accounting/services/reportingEngineService';

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
  depreciation: 50000,
  amortization: 10000,
  interestExpense: 30000,
  operatingCashFlow: 250000,
  capitalExpenditure: 80000,
  employeeCount: 10,
};

describe('Extended Financial Ratios', () => {
  it('calculates EBITDA margin', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.ebitdaMargin).toBeCloseTo(26, 0);
  });

  it('calculates EBITDA amount', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.ebitda).toBeCloseTo(260000, 0);
  });

  it('calculates ROCE', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.roce).toBeCloseTo(11.76, 0);
  });

  it('calculates interest coverage ratio', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.interestCoverage).toBeCloseTo(6.67, 1);
  });

  it('calculates debt ratio', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.debtRatio).toBeCloseTo(0.40, 2);
  });

  it('calculates equity multiplier', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.equityMultiplier).toBeCloseTo(1.67, 1);
  });

  it('calculates cash ratio', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.cashRatio).toBeCloseTo(0.50, 2);
  });

  it('calculates working capital', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.workingCapital).toBe(200000);
  });

  it('calculates operating cash flow ratio', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.operatingCashFlowRatio).toBeCloseTo(0.83, 1);
  });

  it('calculates asset turnover', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.assetTurnover).toBeCloseTo(0.50, 2);
  });

  it('calculates receivables turnover', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.receivablesTurnover).toBeCloseTo(5.00, 1);
  });

  it('calculates payables turnover', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.payablesTurnover).toBeCloseTo(4.00, 1);
  });

  it('calculates inventory days', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.inventoryDays).toBeCloseTo(60.83, 0);
  });

  it('calculates cash conversion cycle', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.cashConversionCycle).toBeCloseTo(42.58, 0);
  });

  it('calculates free cash flow', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.freeCashFlow).toBe(170000);
  });

  it('calculates revenue per employee', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.revenuePerEmployee).toBe(100000);
  });

  it('calculates DuPont ROE components', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.dupontMargin).toBeCloseTo(20, 0);
    expect(r.dupontTurnover).toBeCloseTo(0.50, 2);
    expect(r.dupontLeverage).toBeCloseTo(1.67, 1);
  });

  it('handles zero denominators', () => {
    const zeroData: FinancialData = {
      revenue: 0, costOfSales: 0, operatingExpenses: 0, netProfit: 0,
      totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
      currentAssets: 0, currentLiabilities: 0,
      inventory: 0, accountsReceivable: 0, accountsPayable: 0, cash: 0,
      depreciation: 0, amortization: 0, interestExpense: 0,
      operatingCashFlow: 0, capitalExpenditure: 0, employeeCount: 0,
    };
    const r = calculateExtendedRatios(zeroData);
    expect(r.ebitdaMargin).toBe(0);
    expect(r.interestCoverage).toBe(0);
    expect(r.cashRatio).toBe(0);
    expect(r.assetTurnover).toBe(0);
    expect(r.revenuePerEmployee).toBe(0);
  });

  it('handles negative equity', () => {
    const r = calculateExtendedRatios({ ...sampleData, totalEquity: -200000 });
    expect(r.equityMultiplier).toBeDefined();
    expect(r.roce).toBeDefined();
  });

  it('handles missing optional fields', () => {
    const minimal: FinancialData = {
      revenue: 500000, costOfSales: 300000, operatingExpenses: 100000,
      netProfit: 100000, totalAssets: 1000000, totalLiabilities: 400000,
      totalEquity: 600000, currentAssets: 300000, currentLiabilities: 200000,
      inventory: 50000, accountsReceivable: 100000, accountsPayable: 80000, cash: 100000,
    };
    const r = calculateExtendedRatios(minimal);
    expect(r.ebitda).toBeCloseTo(100000, 0);
    expect(r.freeCashFlow).toBe(0);
    expect(r.revenuePerEmployee).toBe(0);
  });

  it('includes all original ratio fields', () => {
    const r = calculateExtendedRatios(sampleData);
    expect(r.grossProfitMargin).toBeDefined();
    expect(r.netProfitMargin).toBeDefined();
    expect(r.currentRatio).toBeDefined();
    expect(r.debtToEquity).toBeDefined();
    expect(r.inventoryTurnover).toBeDefined();
  });
});
