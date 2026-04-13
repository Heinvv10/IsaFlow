/**
 * Three-Way Forecast Service
 * Generates linked P&L, Balance Sheet, and Cash Flow projections.
 * Validates: BS balances (A=L+E), CF reconciles to BS cash movement.
 * Pure business logic — no database dependencies.
 */

export interface HistoricalFinancials {
  revenue: number;
  costOfSales: number;
  operatingExpenses: number;
  netProfit: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  currentAssets: number;
  currentLiabilities: number;
  cash: number;
  accountsReceivable: number;
  accountsPayable: number;
  inventory: number;
}

export interface ForecastParams {
  revenueGrowthRate: number;     // %
  costOfSalesGrowthRate: number; // %
  opexGrowthRate: number;        // %
  capitalExpenditure: number;    // absolute amount per month
  taxRate?: number;              // %, default 27
  dividendPayout?: number;       // absolute amount per month, default 0
}

export interface ForecastPnL {
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  ebit: number;
  taxExpense: number;
  netProfit: number;
}

export interface ForecastBalanceSheet {
  cash: number;
  accountsReceivable: number;
  otherCurrentAssets: number;
  currentAssets: number;
  fixedAssets: number;
  totalAssets: number;
  accountsPayable: number;
  otherCurrentLiabilities: number;
  currentLiabilities: number;
  longTermLiabilities: number;
  totalLiabilities: number;
  retainedEarnings: number;
  totalEquity: number;
}

export interface ForecastCashFlow {
  operatingCashFlow: number;
  investingCashFlow: number;
  financingCashFlow: number;
  netCashFlow: number;
  openingCash: number;
  closingCash: number;
}

export interface ForecastMonth {
  month: number;
  label: string;
  pnl: ForecastPnL;
  balanceSheet: ForecastBalanceSheet;
  cashFlow: ForecastCashFlow;
}

export interface ForecastValidation {
  balanceSheetBalances: boolean;
  cashFlowReconciles: boolean;
  bsDiff: number;
  cfDiff: number;
}

export interface ThreeWayForecastResult {
  months: ForecastMonth[];
  params: ForecastParams;
  generatedAt: string;
}

const TOLERANCE = 1; // R1 rounding tolerance

function applyGrowth(base: number, ratePct: number, monthIndex: number): number {
  // Compound monthly growth
  const monthlyRate = ratePct / 100 / 12;
  return Math.round(base * Math.pow(1 + monthlyRate, monthIndex) * 100) / 100;
}

export function projectPnL(
  historical: HistoricalFinancials,
  params: ForecastParams,
  monthIndex: number,
): ForecastPnL {
  const revenue = applyGrowth(historical.revenue, params.revenueGrowthRate, monthIndex);
  const costOfSales = applyGrowth(historical.costOfSales, params.costOfSalesGrowthRate, monthIndex);
  const grossProfit = revenue - costOfSales;
  const operatingExpenses = applyGrowth(historical.operatingExpenses, params.opexGrowthRate, monthIndex);
  const ebit = grossProfit - operatingExpenses;
  const taxRate = params.taxRate ?? 27;
  const taxExpense = ebit > 0 ? Math.round(ebit * (taxRate / 100) * 100) / 100 : 0;
  const netProfit = Math.round((ebit - taxExpense) * 100) / 100;

  return { revenue, costOfSales, grossProfit, operatingExpenses, ebit, taxExpense, netProfit };
}

export function projectBalanceSheet(
  historical: HistoricalFinancials,
  params: ForecastParams,
  monthIndex: number,
  netProfit: number,
  closingCash?: number,
): ForecastBalanceSheet {
  // AR grows proportionally with revenue growth
  const monthlyRevRate = params.revenueGrowthRate / 100 / 12;
  const accountsReceivable = Math.round(historical.accountsReceivable * Math.pow(1 + monthlyRevRate, monthIndex) * 100) / 100;

  // AP grows proportionally with COGS growth
  const monthlyCOGSRate = params.costOfSalesGrowthRate / 100 / 12;
  const accountsPayable = Math.round(historical.accountsPayable * Math.pow(1 + monthlyCOGSRate, monthIndex) * 100) / 100;

  // Fixed assets: prior + capex (simple model, no depreciation)
  const capexThisPeriod = params.capitalExpenditure;
  const fixedAssets = Math.max(0, Math.round((historical.totalAssets - historical.currentAssets + capexThisPeriod) * 100) / 100);

  // Other current assets remain stable
  const otherCurrentAssets = Math.max(0, historical.currentAssets - historical.cash - historical.accountsReceivable);

  // Liabilities
  const otherCurrentLiabilities = Math.max(0, historical.currentLiabilities - historical.accountsPayable);
  const currentLiabilities = Math.round((accountsPayable + otherCurrentLiabilities) * 100) / 100;
  const longTermLiabilities = Math.round(Math.max(0, historical.totalLiabilities - historical.currentLiabilities) * 100) / 100;
  const totalLiabilities = Math.round((currentLiabilities + longTermLiabilities) * 100) / 100;

  // Equity: prior equity + this period's net profit
  const totalEquity = Math.round((historical.totalEquity + netProfit) * 100) / 100;
  const retainedEarnings = Math.round((historical.totalEquity - historical.totalLiabilities + netProfit) * 100) / 100;

  // Force balance: totalAssets = totalLiabilities + totalEquity (plug into cash)
  const nonCashCurrentAssets = Math.round((accountsReceivable + otherCurrentAssets) * 100) / 100;
  const impliedTotalAssets = Math.round((totalLiabilities + totalEquity) * 100) / 100;
  const impliedCurrentAssets = Math.round((impliedTotalAssets - fixedAssets) * 100) / 100;

  // Cash = implied current assets - non-cash current assets
  const cash = closingCash !== undefined
    ? closingCash
    : Math.round((impliedCurrentAssets - nonCashCurrentAssets) * 100) / 100;

  // Rebuild current assets and total assets using actual cash
  const currentAssets = Math.round((cash + nonCashCurrentAssets) * 100) / 100;
  const totalAssets = Math.round((currentAssets + fixedAssets) * 100) / 100;

  return {
    cash,
    accountsReceivable,
    otherCurrentAssets: Math.round(otherCurrentAssets * 100) / 100,
    currentAssets,
    fixedAssets,
    totalAssets,
    accountsPayable,
    otherCurrentLiabilities,
    currentLiabilities,
    longTermLiabilities,
    totalLiabilities,
    retainedEarnings,
    totalEquity,
  };
}

export function projectCashFlow(
  historical: HistoricalFinancials,
  pnl: ForecastPnL,
  bs: ForecastBalanceSheet,
  params: ForecastParams,
): ForecastCashFlow {
  // Operating: net profit + working capital movements
  const arChange = -(bs.accountsReceivable - historical.accountsReceivable);
  const apChange = bs.accountsPayable - historical.accountsPayable;
  const operatingCashFlow = Math.round((pnl.netProfit + arChange + apChange) * 100) / 100;

  // Investing: capex
  const investingCashFlow = -params.capitalExpenditure;

  // Financing: dividends
  const dividends = params.dividendPayout ?? 0;
  const financingCashFlow = -dividends;

  const netCashFlow = Math.round((operatingCashFlow + investingCashFlow + financingCashFlow) * 100) / 100;
  const openingCash = historical.cash;
  const closingCash = Math.round((openingCash + netCashFlow) * 100) / 100;

  return { operatingCashFlow, investingCashFlow, financingCashFlow, netCashFlow, openingCash, closingCash };
}

export function validateForecast(month: ForecastMonth): ForecastValidation {
  const bs = month.balanceSheet;
  const cf = month.cashFlow;

  // Check A = L + E
  const bsDiff = Math.abs(bs.totalAssets - (bs.totalLiabilities + bs.totalEquity));
  const balanceSheetBalances = bsDiff < TOLERANCE;

  // Check CF net reconciles to cash movement (closing - opening)
  const cashMovement = cf.closingCash - cf.openingCash;
  const cfNet = cf.operatingCashFlow + cf.investingCashFlow + cf.financingCashFlow;
  const cfDiff = Math.abs(cfNet - cashMovement);
  const cashFlowReconciles = cfDiff < TOLERANCE;

  return { balanceSheetBalances, cashFlowReconciles, bsDiff, cfDiff };
}

function monthLabel(baseDate: Date, offset: number): string {
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth() + offset, 1);
  return d.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
}

export function generateThreeWayForecast(
  historical: HistoricalFinancials,
  params: ForecastParams,
  months: number,
): ThreeWayForecastResult {
  const now = new Date();
  const result: ForecastMonth[] = [];

  let prevHistorical = { ...historical };

  for (let i = 1; i <= months; i++) {
    const pnl = projectPnL(historical, params, i);

    // Pass 1: project BS without final cash to derive AR/AP movements
    const bsPass1 = projectBalanceSheet(prevHistorical, params, 1, pnl.netProfit);

    // Project CF using AR/AP from BS pass 1
    const cf = projectCashFlow(prevHistorical, pnl, bsPass1, params);

    // Pass 2: project BS with actual closing cash from CF
    const finalBS = projectBalanceSheet(prevHistorical, params, 1, pnl.netProfit, cf.closingCash);

    result.push({
      month: i,
      label: monthLabel(now, i),
      pnl,
      balanceSheet: finalBS,
      cashFlow: cf,
    });

    // Roll forward
    prevHistorical = {
      revenue: pnl.revenue,
      costOfSales: pnl.costOfSales,
      operatingExpenses: pnl.operatingExpenses,
      netProfit: pnl.netProfit,
      totalAssets: finalBS.totalAssets,
      totalLiabilities: finalBS.totalLiabilities,
      totalEquity: finalBS.totalEquity,
      currentAssets: finalBS.currentAssets,
      currentLiabilities: finalBS.currentLiabilities,
      cash: cf.closingCash,
      accountsReceivable: finalBS.accountsReceivable,
      accountsPayable: finalBS.accountsPayable,
      inventory: historical.inventory,
    };
  }

  return {
    months: result,
    params,
    generatedAt: new Date().toISOString(),
  };
}
