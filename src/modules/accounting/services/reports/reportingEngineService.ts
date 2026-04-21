/**
 * Enhanced Reporting Engine — ratios, comparatives, management packs, formatting
 * Pure business logic — no database dependencies.
 */

export interface FinancialData {
  revenue: number;
  costOfSales: number;
  operatingExpenses: number;
  netProfit: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  currentAssets: number;
  currentLiabilities: number;
  inventory: number;
  accountsReceivable: number;
  accountsPayable: number;
  cash: number;
  // Extended (optional for backward compat)
  depreciation?: number;
  amortization?: number;
  interestExpense?: number;
  interestIncome?: number;
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  employeeCount?: number;
  // AFS Master v15 additions
  employeeCosts?: number;
  directMaterialCosts?: number;
  taxExpense?: number;
  dividendsPaid?: number;
  nonCurrentAssets?: number;
  nonCurrentLiabilities?: number;
}

export interface RatioResult {
  grossProfitMargin: number;
  netProfitMargin: number;
  operatingProfitMargin: number;
  currentRatio: number;
  quickRatio: number;
  debtToEquity: number;
  returnOnAssets: number;
  returnOnEquity: number;
  debtorDays: number;
  creditorDays: number;
  inventoryTurnover: number;
}

export interface ExtendedRatioResult extends RatioResult {
  // Profitability
  ebitda: number;
  ebitdaMargin: number;
  roce: number; // Return on Capital Employed
  pbitMargin: number; // Profit Before Interest & Tax margin
  directMaterialMargin: number; // (Revenue - Direct Materials) / Revenue
  // Leverage
  interestCoverage: number;
  debtRatio: number;
  equityMultiplier: number;
  // Liquidity
  cashRatio: number;
  workingCapital: number;
  operatingCashFlowRatio: number;
  // Efficiency
  assetTurnover: number;
  receivablesTurnover: number;
  payablesTurnover: number;
  inventoryDays: number;
  cashConversionCycle: number;
  netOperatingAssetTurnover: number; // Revenue / (Total Assets - Cash - Current Liabilities)
  // Cash Flow
  freeCashFlow: number;
  // Coverage (AFS Master v15)
  ebitdaToNetInterest: number;
  pbtToNetInterest: number;
  netProfitToNetInterest: number;
  // Employee Productivity (AFS Master v15)
  revenuePerEmployee: number;
  pbitPerEmployee: number;
  ebitdaPerEmployee: number;
  employeeCostToRevenue: number;
  employeeCostPerHead: number;
  // Returns
  dividendCover: number;
  retentionRate: number;
  effectiveTaxRate: number;
  // DuPont Decomposition
  dupontMargin: number;
  dupontTurnover: number;
  dupontLeverage: number;
}

export interface VarianceResult {
  amount: number;
  percentage: number;
  direction: 'favorable' | 'unfavorable' | 'on_budget';
}

export interface ComparativeRow {
  account: string;
  currentAmount: number;
  priorAmount: number;
  changeAmount: number;
  changePercent: number;
}

export interface ManagementPackSection {
  title: string;
  items: Array<{ label: string; value: string | number }>;
}

export interface ManagementPack {
  companyName: string;
  period: string;
  generatedAt: string;
  profitMargin: number;
  sections: ManagementPackSection[];
}

// ═══════════════════════════════════════════════════════════════════════════
// FINANCIAL RATIOS
// ═══════════════════════════════════════════════════════════════════════════

function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10000) / 10000;
}

function pct(numerator: number, denominator: number): number {
  return Math.round(safeDiv(numerator, denominator) * 10000) / 100;
}

export function calculateFinancialRatios(data: FinancialData): RatioResult {
  const grossProfit = data.revenue - data.costOfSales;
  const operatingProfit = grossProfit - data.operatingExpenses;

  return {
    grossProfitMargin: pct(grossProfit, data.revenue),
    netProfitMargin: pct(data.netProfit, data.revenue),
    operatingProfitMargin: pct(operatingProfit, data.revenue),
    currentRatio: Math.round(safeDiv(data.currentAssets, data.currentLiabilities) * 100) / 100,
    quickRatio: Math.round(safeDiv(data.currentAssets - data.inventory, data.currentLiabilities) * 100) / 100,
    debtToEquity: Math.round(safeDiv(data.totalLiabilities, data.totalEquity) * 100) / 100,
    returnOnAssets: pct(data.netProfit, data.totalAssets),
    returnOnEquity: pct(data.netProfit, data.totalEquity),
    debtorDays: Math.round(safeDiv(data.accountsReceivable, data.revenue) * 365 * 100) / 100,
    creditorDays: Math.round(safeDiv(data.accountsPayable, data.costOfSales) * 365 * 100) / 100,
    inventoryTurnover: Math.round(safeDiv(data.costOfSales, data.inventory) * 100) / 100,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTENDED FINANCIAL RATIOS (30+)
// ═══════════════════════════════════════════════════════════════════════════

export function calculateExtendedRatios(data: FinancialData): ExtendedRatioResult {
  const base = calculateFinancialRatios(data);
  const grossProfit = data.revenue - data.costOfSales;
  const ebit = grossProfit - data.operatingExpenses;
  const dep = data.depreciation ?? 0;
  const amort = data.amortization ?? 0;
  const interestExp = data.interestExpense ?? 0;
  const interestInc = data.interestIncome ?? 0;
  const netInterest = interestExp - interestInc;
  const opCF = data.operatingCashFlow ?? 0;
  const capex = data.capitalExpenditure ?? 0;
  const employees = data.employeeCount ?? 0;
  const employeeCosts = data.employeeCosts ?? 0;
  const directMaterials = data.directMaterialCosts ?? 0;
  const taxExpense = data.taxExpense ?? 0;
  const dividendsPaid = data.dividendsPaid ?? 0;
  const capitalEmployed = data.totalAssets - data.currentLiabilities;

  const ebitda = ebit + dep + amort;
  const pbt = ebit - interestExp + interestInc; // Profit Before Tax
  const invTurnover = base.inventoryTurnover || 0;
  const inventoryDays = invTurnover > 0 ? Math.round((365 / invTurnover) * 100) / 100 : 0;

  // Net operating assets = Total Assets - Cash - Current Liabilities
  const netOperatingAssets = data.totalAssets - data.cash - data.currentLiabilities;

  const r2 = (n: number) => Math.round(n * 100) / 100;

  return {
    ...base,
    // Profitability
    ebitda: r2(ebitda),
    ebitdaMargin: pct(ebitda, data.revenue),
    roce: pct(ebit, capitalEmployed),
    pbitMargin: pct(ebit, data.revenue),
    directMaterialMargin: directMaterials > 0 ? pct(data.revenue - directMaterials, data.revenue) : 0,
    // Leverage
    interestCoverage: interestExp > 0 ? r2(safeDiv(ebit, interestExp)) : 0,
    debtRatio: r2(safeDiv(data.totalLiabilities, data.totalAssets)),
    equityMultiplier: r2(safeDiv(data.totalAssets, data.totalEquity)),
    // Liquidity
    cashRatio: r2(safeDiv(data.cash, data.currentLiabilities)),
    workingCapital: r2(data.currentAssets - data.currentLiabilities),
    operatingCashFlowRatio: r2(safeDiv(opCF, data.currentLiabilities)),
    // Efficiency
    assetTurnover: r2(safeDiv(data.revenue, data.totalAssets)),
    receivablesTurnover: r2(safeDiv(data.revenue, data.accountsReceivable)),
    payablesTurnover: r2(safeDiv(data.costOfSales, data.accountsPayable)),
    inventoryDays,
    cashConversionCycle: r2(base.debtorDays + inventoryDays - base.creditorDays),
    netOperatingAssetTurnover: netOperatingAssets > 0 ? r2(safeDiv(data.revenue, netOperatingAssets)) : 0,
    // Cash Flow
    freeCashFlow: r2(opCF - capex),
    // Coverage (AFS Master v15 — interest coverage variants)
    ebitdaToNetInterest: netInterest > 0 ? r2(safeDiv(ebitda, netInterest)) : 0,
    pbtToNetInterest: netInterest > 0 ? r2(safeDiv(pbt, netInterest)) : 0,
    netProfitToNetInterest: netInterest > 0 ? r2(safeDiv(data.netProfit, netInterest)) : 0,
    // Employee Productivity (AFS Master v15)
    revenuePerEmployee: employees > 0 ? r2(safeDiv(data.revenue, employees)) : 0,
    pbitPerEmployee: employees > 0 ? r2(safeDiv(ebit, employees)) : 0,
    ebitdaPerEmployee: employees > 0 ? r2(safeDiv(ebitda, employees)) : 0,
    employeeCostToRevenue: employeeCosts > 0 ? pct(employeeCosts, data.revenue) : 0,
    employeeCostPerHead: employees > 0 && employeeCosts > 0 ? r2(safeDiv(employeeCosts, employees)) : 0,
    // Returns
    dividendCover: dividendsPaid > 0 ? r2(safeDiv(data.netProfit, dividendsPaid)) : 0,
    retentionRate: data.netProfit !== 0 ? pct(data.netProfit - dividendsPaid, data.netProfit) : 0,
    effectiveTaxRate: pbt !== 0 ? pct(taxExpense, pbt) : 0,
    // DuPont Decomposition
    dupontMargin: pct(data.netProfit, data.revenue),
    dupontTurnover: r2(safeDiv(data.revenue, data.totalAssets)),
    dupontLeverage: r2(safeDiv(data.totalAssets, data.totalEquity)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// VARIANCE
// ═══════════════════════════════════════════════════════════════════════════

export function calculateVariance(actual: number, budget: number, isExpense = false): VarianceResult {
  const amount = Math.round((actual - budget) * 100) / 100;
  const percentage = budget !== 0 ? Math.round((amount / budget) * 10000) / 100 : 0;

  let direction: VarianceResult['direction'] = 'on_budget';
  if (amount > 0) direction = isExpense ? 'unfavorable' : 'favorable';
  else if (amount < 0) direction = isExpense ? 'favorable' : 'unfavorable';

  return { amount, percentage, direction };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPARATIVE DATA
// ═══════════════════════════════════════════════════════════════════════════

export function buildComparativeData(
  current: Array<{ account: string; amount: number }>,
  prior: Array<{ account: string; amount: number }>,
): ComparativeRow[] {
  const priorMap = new Map(prior.map(p => [p.account, p.amount]));

  return current.map(c => {
    const priorAmount = priorMap.get(c.account) ?? 0;
    const changeAmount = Math.round((c.amount - priorAmount) * 100) / 100;
    const changePercent = priorAmount !== 0 ? Math.round((changeAmount / priorAmount) * 10000) / 100 : 0;

    return {
      account: c.account,
      currentAmount: c.amount,
      priorAmount,
      changeAmount,
      changePercent,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MANAGEMENT PACK
// ═══════════════════════════════════════════════════════════════════════════

export function buildManagementPack(input: {
  companyName: string;
  period: string;
  revenue: number;
  expenses: number;
  netProfit: number;
  cashBalance: number;
  arOutstanding: number;
  apOutstanding: number;
}): ManagementPack {
  const profitMargin = input.revenue > 0
    ? Math.round((input.netProfit / input.revenue) * 10000) / 100
    : 0;

  const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

  return {
    companyName: input.companyName,
    period: input.period,
    generatedAt: new Date().toISOString(),
    profitMargin,
    sections: [
      {
        title: 'KPI Summary',
        items: [
          { label: 'Revenue', value: fmt(input.revenue) },
          { label: 'Total Expenses', value: fmt(input.expenses) },
          { label: 'Net Profit', value: fmt(input.netProfit) },
          { label: 'Profit Margin', value: `${profitMargin}%` },
        ],
      },
      {
        title: 'Cash Position',
        items: [
          { label: 'Cash Balance', value: fmt(input.cashBalance) },
          { label: 'AR Outstanding', value: fmt(input.arOutstanding) },
          { label: 'AP Outstanding', value: fmt(input.apOutstanding) },
          { label: 'Net Working Capital', value: fmt(input.cashBalance + input.arOutstanding - input.apOutstanding) },
        ],
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

export function formatReportNumber(value: number, format: 'currency' | 'percent' | 'number'): string {
  switch (format) {
    case 'currency':
      return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(value);
    case 'percent':
      return `${Math.round(value * 100) / 100}%`;
    case 'number':
      return new Intl.NumberFormat('en-ZA').format(value);
    default:
      return String(value);
  }
}
