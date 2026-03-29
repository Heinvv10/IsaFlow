import { describe, it, expect } from 'vitest';
import {
  buildThreeWayForecast,
  calculateSensitivity,
  type ThreeWayInput,
  type SensitivityInput,
} from '@/modules/accounting/services/scenarioPlanningService';

describe('Three-Way Forecast', () => {
  it('builds integrated P&L, BS, Cash Flow', () => {
    const result = buildThreeWayForecast({
      revenue: 500000, costOfSales: 300000, operatingExpenses: 100000,
      currentAssets: 400000, currentLiabilities: 200000,
      openingCash: 150000, months: 3,
    });
    expect(result.profitAndLoss).toBeDefined();
    expect(result.balanceSheet).toBeDefined();
    expect(result.cashFlow).toBeDefined();
    expect(result.profitAndLoss.netProfit).toBe(100000);
  });
  it('projects cash balance over months', () => {
    const result = buildThreeWayForecast({
      revenue: 100000, costOfSales: 60000, operatingExpenses: 20000,
      currentAssets: 200000, currentLiabilities: 100000, openingCash: 50000, months: 6,
    });
    expect(result.cashFlow.monthlyProjections.length).toBe(6);
    expect(result.cashFlow.closingCash).toBeGreaterThan(50000);
  });
});

describe('Sensitivity Analysis', () => {
  it('identifies revenue as highest impact', () => {
    const result = calculateSensitivity({
      baseRevenue: 500000, baseCost: 350000, baseExpenses: 100000,
      revenueVariation: 0.1, costVariation: 0.1, expenseVariation: 0.1,
    });
    expect(result.factors.length).toBe(3);
    // Revenue 10% change has biggest absolute impact on profit
    expect(result.factors[0]!.name).toContain('Revenue');
  });
  it('calculates profit impact per factor', () => {
    const result = calculateSensitivity({
      baseRevenue: 100000, baseCost: 60000, baseExpenses: 20000,
      revenueVariation: 0.1, costVariation: 0.1, expenseVariation: 0.1,
    });
    // Base profit = 100k - 60k - 20k = 20k
    // Revenue +10% = 110k - 60k - 20k = 30k → impact = +10k
    expect(result.factors.find(f => f.name.includes('Revenue'))!.profitImpact).toBe(10000);
  });
});
