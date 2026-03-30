/**
 * TDD: Three-Way Forecast Service
 * Tests for linked P&L, Balance Sheet, and Cash Flow forecast.
 */

import { describe, it, expect } from 'vitest';
import {
  generateThreeWayForecast,
  projectPnL,
  projectBalanceSheet,
  projectCashFlow,
  validateForecast,
  type HistoricalFinancials,
  type ForecastParams,
} from '@/modules/accounting/services/threeWayForecastService';

const historical: HistoricalFinancials = {
  revenue: 1000000,
  costOfSales: 600000,
  operatingExpenses: 200000,
  netProfit: 200000,
  totalAssets: 2000000,
  totalLiabilities: 800000,
  totalEquity: 1200000,
  currentAssets: 500000,
  currentLiabilities: 300000,
  cash: 150000,
  accountsReceivable: 200000,
  accountsPayable: 100000,
  inventory: 0,
};

const params: ForecastParams = {
  revenueGrowthRate: 5,
  costOfSalesGrowthRate: 3,
  opexGrowthRate: 2,
  capitalExpenditure: 50000,
};

describe('Three-Way Forecast Service', () => {
  it('generates forecast with correct number of months', () => {
    const result = generateThreeWayForecast(historical, params, 6);
    expect(result.months).toHaveLength(6);
  });

  it('P&L revenue grows by specified rate', () => {
    const pnl = projectPnL(historical, params, 1);
    // Monthly compound: base * (1 + annualRate/1200)^1
    const monthlyRate = params.revenueGrowthRate / 100 / 12;
    const expectedRevenue = historical.revenue * Math.pow(1 + monthlyRate, 1);
    expect(pnl.revenue).toBeCloseTo(expectedRevenue, 0);
  });

  it('balance sheet assets equal liabilities plus equity', () => {
    const bs = projectBalanceSheet(historical, params, 1, 200000);
    const diff = Math.abs(bs.totalAssets - (bs.totalLiabilities + bs.totalEquity));
    expect(diff).toBeLessThan(1); // within R1 rounding tolerance
  });

  it('cash flow reconciles to balance sheet cash movement', () => {
    // Use generateThreeWayForecast which does the two-pass correction
    const result = generateThreeWayForecast(historical, params, 1);
    const month = result.months[0]!;
    const cf = month.cashFlow;
    const bsCashChange = month.balanceSheet.cash - historical.cash;
    const cfNet = cf.operatingCashFlow + cf.investingCashFlow + cf.financingCashFlow;
    expect(Math.abs(cfNet - bsCashChange)).toBeLessThan(1);
  });

  it('validates balance sheet equation holds', () => {
    const result = generateThreeWayForecast(historical, params, 3);
    result.months.forEach(month => {
      const validation = validateForecast(month);
      expect(validation.balanceSheetBalances).toBe(true);
    });
  });

  it('validates cash flow reconciliation', () => {
    const result = generateThreeWayForecast(historical, params, 3);
    result.months.forEach(month => {
      const validation = validateForecast(month);
      expect(validation.cashFlowReconciles).toBe(true);
    });
  });

  it('forecast result has all required sections', () => {
    const result = generateThreeWayForecast(historical, params, 3);
    expect(result).toHaveProperty('months');
    expect(result).toHaveProperty('params');
    expect(result).toHaveProperty('generatedAt');
    result.months.forEach(m => {
      expect(m).toHaveProperty('month');
      expect(m).toHaveProperty('pnl');
      expect(m).toHaveProperty('balanceSheet');
      expect(m).toHaveProperty('cashFlow');
    });
  });

  it('projects zero growth correctly', () => {
    const flat: ForecastParams = { revenueGrowthRate: 0, costOfSalesGrowthRate: 0, opexGrowthRate: 0, capitalExpenditure: 0, taxRate: 0 };
    const pnl = projectPnL(historical, flat, 1);
    expect(pnl.revenue).toBeCloseTo(historical.revenue, 0);
    // With 0% tax and 0% growth, netProfit = revenue - costOfSales - opex = 200000
    expect(pnl.netProfit).toBeCloseTo(historical.netProfit, 0);
  });
});
