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
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  employeeCount?: number;
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
  // Cash Flow
  freeCashFlow: number;
  // Per-Unit
  revenuePerEmployee: number;
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
  const interest = data.interestExpense ?? 0;
  const opCF = data.operatingCashFlow ?? 0;
  const capex = data.capitalExpenditure ?? 0;
  const employees = data.employeeCount ?? 0;
  const capitalEmployed = data.totalAssets - data.currentLiabilities;

  const ebitda = ebit + dep + amort;
  const invTurnover = base.inventoryTurnover || 0;
  const inventoryDays = invTurnover > 0 ? Math.round((365 / invTurnover) * 100) / 100 : 0;

  return {
    ...base,
    // Profitability
    ebitda: Math.round(ebitda * 100) / 100,
    ebitdaMargin: pct(ebitda, data.revenue),
    roce: pct(ebit, capitalEmployed),
    // Leverage
    interestCoverage: interest > 0 ? Math.round(safeDiv(ebit, interest) * 100) / 100 : 0,
    debtRatio: Math.round(safeDiv(data.totalLiabilities, data.totalAssets) * 100) / 100,
    equityMultiplier: Math.round(safeDiv(data.totalAssets, data.totalEquity) * 100) / 100,
    // Liquidity
    cashRatio: Math.round(safeDiv(data.cash, data.currentLiabilities) * 100) / 100,
    workingCapital: Math.round((data.currentAssets - data.currentLiabilities) * 100) / 100,
    operatingCashFlowRatio: Math.round(safeDiv(opCF, data.currentLiabilities) * 100) / 100,
    // Efficiency
    assetTurnover: Math.round(safeDiv(data.revenue, data.totalAssets) * 100) / 100,
    receivablesTurnover: Math.round(safeDiv(data.revenue, data.accountsReceivable) * 100) / 100,
    payablesTurnover: Math.round(safeDiv(data.costOfSales, data.accountsPayable) * 100) / 100,
    inventoryDays,
    cashConversionCycle: Math.round((base.debtorDays + inventoryDays - base.creditorDays) * 100) / 100,
    // Cash Flow
    freeCashFlow: Math.round((opCF - capex) * 100) / 100,
    // Per-Unit
    revenuePerEmployee: employees > 0 ? Math.round(safeDiv(data.revenue, employees) * 100) / 100 : 0,
    // DuPont Decomposition
    dupontMargin: pct(data.netProfit, data.revenue),
    dupontTurnover: Math.round(safeDiv(data.revenue, data.totalAssets) * 100) / 100,
    dupontLeverage: Math.round(safeDiv(data.totalAssets, data.totalEquity) * 100) / 100,
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
