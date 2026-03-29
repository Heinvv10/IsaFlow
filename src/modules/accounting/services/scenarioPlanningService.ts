/**
 * Scenario Planning & Financial Modeling Service
 */

export interface ThreeWayInput {
  revenue: number; costOfSales: number; operatingExpenses: number;
  currentAssets: number; currentLiabilities: number;
  openingCash: number; months: number;
}

export interface ThreeWayResult {
  profitAndLoss: { revenue: number; costOfSales: number; grossProfit: number; operatingExpenses: number; netProfit: number };
  balanceSheet: { totalAssets: number; totalLiabilities: number; equity: number };
  cashFlow: { openingCash: number; closingCash: number; netCashFlow: number; monthlyProjections: Array<{ month: number; cash: number }> };
}

export interface SensitivityInput {
  baseRevenue: number; baseCost: number; baseExpenses: number;
  revenueVariation: number; costVariation: number; expenseVariation: number;
}

export interface SensitivityResult {
  baseProfit: number;
  factors: Array<{ name: string; variation: number; profitImpact: number; percentImpact: number }>;
}

export function buildThreeWayForecast(input: ThreeWayInput): ThreeWayResult {
  const grossProfit = input.revenue - input.costOfSales;
  const netProfit = grossProfit - input.operatingExpenses;
  const monthlyCash = Math.round(netProfit / Math.max(1, input.months) * 100) / 100;

  const projections: Array<{ month: number; cash: number }> = [];
  let runningCash = input.openingCash;
  for (let m = 1; m <= input.months; m++) {
    runningCash = Math.round((runningCash + monthlyCash) * 100) / 100;
    projections.push({ month: m, cash: runningCash });
  }

  return {
    profitAndLoss: { revenue: input.revenue, costOfSales: input.costOfSales, grossProfit, operatingExpenses: input.operatingExpenses, netProfit },
    balanceSheet: { totalAssets: input.currentAssets + input.openingCash, totalLiabilities: input.currentLiabilities, equity: input.currentAssets + input.openingCash - input.currentLiabilities },
    cashFlow: { openingCash: input.openingCash, closingCash: runningCash, netCashFlow: runningCash - input.openingCash, monthlyProjections: projections },
  };
}

export function calculateSensitivity(input: SensitivityInput): SensitivityResult {
  const baseProfit = input.baseRevenue - input.baseCost - input.baseExpenses;

  const factors = [
    { name: 'Revenue', variation: input.revenueVariation, profitImpact: Math.round(input.baseRevenue * input.revenueVariation * 100) / 100 },
    { name: 'Cost of Sales', variation: input.costVariation, profitImpact: Math.round(-input.baseCost * input.costVariation * 100) / 100 },
    { name: 'Operating Expenses', variation: input.expenseVariation, profitImpact: Math.round(-input.baseExpenses * input.expenseVariation * 100) / 100 },
  ].map(f => ({ ...f, percentImpact: baseProfit > 0 ? Math.round((f.profitImpact / baseProfit) * 10000) / 100 : 0 }))
    .sort((a, b) => Math.abs(b.profitImpact) - Math.abs(a.profitImpact));

  return { baseProfit, factors };
}
