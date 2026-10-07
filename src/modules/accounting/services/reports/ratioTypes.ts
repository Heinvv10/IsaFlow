/**
 * What the ratio engine takes and what it returns. Moved out of
 * `reportingEngineService.ts`, which re-exports all three, for the 300-line
 * limit.
 */

export interface FinancialData {
  revenue: number;
  costOfSales: number;
  operatingExpenses: number;
  /**
   * Profit from operations, computed once by
   * `gl/accountClassification#aggregateFigures`. Carried rather than derived:
   * every consumer that recomputed `grossProfit - operatingExpenses` locally
   * excluded other income and so reported a different operating line from the
   * income statement and from `profit_and_loss` — the B75 defect, on eight live
   * ratio surfaces. Optional only so a hand-built `FinancialData` need not
   * supply it; when absent the old derivation is used and the caller gets what
   * it always got.
   */
  operatingProfit?: number;
  /** Non-trading income, below the gross-profit line. */
  otherIncome?: number;
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
  /**
   * False where the chart of accounts classifies no inventory, so `inventory`
   * is nil because nothing could be identified, not because none is held.
   * Inventory days, inventory turnover and the cash conversion cycle are then
   * not stated. Undefined: the caller did not say, and nil is taken as nil.
   */
  inventoryClassified?: boolean;
  /**
   * Set by a caller that TRIED to read interest, tax, employee cost, head
   * count and direct materials and could not. The ratios that need them are
   * then unstated with this sentence rather than "not captured in this
   * report", which is true only of a caller that never reads them.
   */
  ledgerInputsNotRead?: string;
  /**
   * The days the flow figures (revenue, cost of sales) cover — the reporting
   * window, both ends counted (`priorPeriod.inclusiveDays`). Debtor, creditor
   * and inventory days multiply by it: 365 over six months' revenue read six
   * months of sales as a year's and doubled the count. Undefined: the caller
   * supplied a year's figures, and 365 is used. Null: the window could not be
   * measured, and no day count is stated.
   */
  periodDays?: number | null;
}

/**
 * EVERY RATIO IS `number | null`, AND NULL MEANS "NOT MEANINGFUL", NOT ZERO.
 *
 * A ratio is a quotient, and a quotient on a base that is zero, negative or
 * was never supplied is not a small number — it is no number. The engine used
 * to answer 0 for a zero base and a sign-flipped figure for a negative one, so
 * a company with negative turnover printed "gross margin 100" and a caller
 * that supplied no capital expenditure printed "free cash flow 0". A null
 * here always has its reason in `notMeaningful`, under the same key.
 */
export interface RatioResult {
  grossProfitMargin: number | null;
  netProfitMargin: number | null;
  operatingProfitMargin: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  /** null when equity is <= 0 — see `notMeaningful`. */
  debtToEquity: number | null;
  returnOnAssets: number | null;
  /** null when equity is <= 0 — see `notMeaningful`. */
  returnOnEquity: number | null;
  debtorDays: number | null;
  creditorDays: number | null;
  inventoryTurnover: number | null;
  /**
   * Ratios that could not be computed, keyed by field name, with the reason.
   *
   * A ratio dividing by equity is arithmetically meaningless once equity is
   * zero or negative, and reporting a number anyway is worse than reporting
   * nothing: with `lowerIsBetter`, an insolvent company's negative
   * debt-to-equity scores as the healthiest possible reading (AN-07). The
   * same holds for every other base — see the note on this interface.
   */
  notMeaningful: Record<string, string>;
}

export interface ExtendedRatioResult extends RatioResult {
  // Profitability
  ebitda: number;
  ebitdaMargin: number | null;
  roce: number | null; // Return on Capital Employed
  pbitMargin: number | null; // Profit Before Interest & Tax margin
  directMaterialMargin: number | null; // (Revenue - Direct Materials) / Revenue
  // Leverage
  interestCoverage: number | null;
  debtRatio: number | null;
  /** null when equity is <= 0 — see `notMeaningful`. */
  equityMultiplier: number | null;
  // Liquidity
  cashRatio: number | null;
  workingCapital: number;
  operatingCashFlowRatio: number | null;
  // Efficiency
  assetTurnover: number | null;
  receivablesTurnover: number | null;
  payablesTurnover: number | null;
  inventoryDays: number | null;
  cashConversionCycle: number | null;
  netOperatingAssetTurnover: number | null; // Revenue / (Total Assets - Cash - Current Liabilities)
  // Cash Flow
  freeCashFlow: number | null;
  // Coverage (AFS Master v15)
  ebitdaToNetInterest: number | null;
  pbtToNetInterest: number | null;
  netProfitToNetInterest: number | null;
  // Employee Productivity (AFS Master v15)
  revenuePerEmployee: number | null;
  pbitPerEmployee: number | null;
  ebitdaPerEmployee: number | null;
  employeeCostToRevenue: number | null;
  employeeCostPerHead: number | null;
  // Returns
  dividendCover: number | null;
  retentionRate: number | null;
  effectiveTaxRate: number | null;
  // DuPont Decomposition
  dupontMargin: number | null;
  dupontTurnover: number | null;
  /** null when equity is <= 0 — see `notMeaningful`. */
  dupontLeverage: number | null;
}
