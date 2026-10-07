/**
 * The ratio engine: every financial ratio the reports print, computed once.
 * Pure — no database. Moved out of `reportingEngineService.ts`, which
 * re-exports both functions, for the 300-line limit.
 *
 * A RATIO IS STATED ONLY ON A POSITIVE BASE AND FROM INPUTS THAT WERE
 * SUPPLIED. Everything else is null with a reason — see `RatioResult` and
 * `ratioBasis.ts`. The quotients themselves are unchanged from what the
 * engine always computed where it could compute them.
 */
import type { ExtendedRatioResult, FinancialData, RatioResult } from './ratioTypes';
import {
  dependsOnUnstated, equityBasisFailure, equityNotMeaningful, NET_INTEREST_IS_INCOME, INTEREST_IS_NET_CREDIT, NO_FREE_CASH_FLOW, NO_STOCK_HELD, NO_INVENTORY_CLASSIFIED, NO_INVENTORY_CLASSIFIED_CYCLE,
  NO_OPERATING_CASH_FLOW_RATIO, noneRecorded, notCaptured, notPositive, PERIOD_LENGTH_NOT_MEASURED,
} from './ratioBasis';

function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10000) / 10000;
}

function pct(numerator: number, denominator: number): number {
  return Math.round(safeDiv(numerator, denominator) * 10000) / 100;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * THE DAYS THE FLOW FIGURES COVER, which every day count multiplies by — the
 * caller's window. It was 365 whatever the window, so a six-month pack read
 * six months of revenue as a year's and printed debtor days twice the book's.
 * Null where the window could not be measured: a day count on a guessed
 * length is not stated.
 */
export function windowDays(data: Pick<FinancialData, 'periodDays'>): number | null {
  return data.periodDays !== null && data.periodDays > 0 ? data.periodDays : null;
}

/**
 * A balance over the flow that fed it, times the days the flow covers —
 * unrounded until the end, so a reader's own division gives the printed
 * figure. Dividing the days by a turnover rounded to two places printed
 * 1 033.33 inventory days for 930 on a month, and nil where it rounded to 0.
 */
const daysOver = (balance: number, flow: number, days: number): number => r2((balance / flow) * days);

/**
 * The operating line, from the classifier when the caller carried it. Other
 * income is ABOVE this line; only finance cost and tax sit below. Deriving it
 * locally is what made eight ratio endpoints disagree with the income statement.
 */
function operatingProfitOf(data: FinancialData): number {
  return data.operatingProfit
    ?? (data.revenue - data.costOfSales + (data.otherIncome ?? 0) - data.operatingExpenses);
}

/**
 * Collects the reasons as the ratios are computed, so a null and its reason
 * cannot be written apart: `on` and `given` are the only two ways a ratio
 * becomes null here, and each records why under the ratio's own key.
 */
function ledger(seed: Record<string, string>) {
  const why: Record<string, string> = { ...seed };
  return {
    why,
    /** `compute()` where `base` is positive; otherwise null, and why. */
    on(key: string, base: number, baseName: string, compute: () => number): number | null {
      if (base > 0) return compute();
      why[key] = notPositive(baseName);
      return null;
    },
    /** `compute()` where no `problem` is given; otherwise null, and why. */
    given(key: string, problem: string | null, compute: () => number): number | null {
      if (problem === null) return compute();
      why[key] = problem;
      return null;
    },
  };
}

export function calculateFinancialRatios(data: FinancialData): RatioResult {
  const grossProfit = data.revenue - data.costOfSales;
  const equityFailure = equityBasisFailure(data.totalEquity);
  const operatingProfit = operatingProfitOf(data);
  const { why, on, given } = ledger(equityNotMeaningful(data.totalEquity));
  const days = windowDays(data);
  // Each day count is computed only where its base is positive AND `days`
  // is stated, so the `?? 0` is never multiplied.
  const noDays = days === null ? PERIOD_LENGTH_NOT_MEASURED : null;
  const dayCount = (balance: number, flow: number): number => daysOver(balance, flow, days ?? 0);
  // Cost of sales is the numerator, so a non-positive one is no turnover —
  // the same rule as creditor and inventory days. Where none is held the
  // turnover has no value and inventory days are nil; see NO_STOCK_HELD.
  const noInventoryTurnover = data.inventoryClassified === false ? NO_INVENTORY_CLASSIFIED
    : data.costOfSales <= 0 ? notPositive('Cost of sales')
    : data.inventory > 0 ? null : data.inventory < 0 ? notPositive('Inventory') : NO_STOCK_HELD;

  return {
    grossProfitMargin: on('grossProfitMargin', data.revenue, 'Revenue', () => pct(grossProfit, data.revenue)),
    netProfitMargin: on('netProfitMargin', data.revenue, 'Revenue', () => pct(data.netProfit, data.revenue)),
    operatingProfitMargin: on('operatingProfitMargin', data.revenue, 'Revenue', () => pct(operatingProfit, data.revenue)),
    currentRatio: on('currentRatio', data.currentLiabilities, 'Current liabilities',
      () => r2(safeDiv(data.currentAssets, data.currentLiabilities))),
    // The acid test takes inventory OFF current assets. On a chart with no
    // inventory account there is no established figure to take off — it is
    // the current ratio under another name. The board pack publishes none.
    quickRatio: given('quickRatio', data.currentLiabilities <= 0 ? notPositive('Current liabilities')
      : data.inventoryClassified === false ? NO_INVENTORY_CLASSIFIED : null,
    () => r2(safeDiv(data.currentAssets - data.inventory, data.currentLiabilities))),
    debtToEquity: equityFailure ? null : r2(safeDiv(data.totalLiabilities, data.totalEquity)),
    returnOnAssets: on('returnOnAssets', data.totalAssets, 'Total assets', () => pct(data.netProfit, data.totalAssets)),
    returnOnEquity: equityFailure ? null : pct(data.netProfit, data.totalEquity),
    debtorDays: given('debtorDays', data.revenue > 0 ? noDays : notPositive('Revenue'),
      () => dayCount(data.accountsReceivable, data.revenue)),
    creditorDays: given('creditorDays', data.costOfSales > 0 ? noDays : notPositive('Cost of sales'),
      () => dayCount(data.accountsPayable, data.costOfSales)),
    inventoryTurnover: given('inventoryTurnover', noInventoryTurnover,
      () => r2(safeDiv(data.costOfSales, data.inventory))),
    notMeaningful: why,
  };
}

/**
 * Why an optional input stops a ratio that divides by it, or null where it
 * can be used. `undefined` is the REPORT not having captured it; a supplied
 * nil is the LEDGER having none — see `ratioBasis.notCaptured`.
 */
function unusable(
  value: number | undefined, captured: string, recorded: string, notRead?: string,
): string | null {
  if (value === undefined) return notRead ?? notCaptured(captured);
  return value > 0 ? null : noneRecorded(recorded);
}

export function calculateExtendedRatios(data: FinancialData): ExtendedRatioResult {
  const base = calculateFinancialRatios(data);
  const equityFailure = equityBasisFailure(data.totalEquity);
  const { why, on, given } = ledger(base.notMeaningful);
  // EBIT is the operating line: earnings before interest and tax, so other
  // income is in and finance cost and tax are out.
  const notRead = data.ledgerInputsNotRead;
  const ebit = operatingProfitOf(data);
  const interestExp = data.interestExpense ?? 0;
  const interestInc = data.interestIncome ?? 0;
  const netInterest = interestExp - interestInc;
  const opCF = data.operatingCashFlow;
  const capex = data.capitalExpenditure;
  const employees = data.employeeCount ?? 0;
  const employeeCosts = data.employeeCosts ?? 0;
  const directMaterials = data.directMaterialCosts ?? 0;
  const dividendsPaid = data.dividendsPaid ?? 0;
  const capitalEmployed = data.totalAssets - data.currentLiabilities;
  const ebitda = ebit + (data.depreciation ?? 0) + (data.amortization ?? 0);
  // PROFIT BEFORE TAX IS THE STATEMENT'S: net profit with the tax put back.
  // It was `ebit - interest + interest income`, which counted interest income
  // twice (it is inside the operating line) and never took off bank charges
  // or the other-expense band — so the tax rate did not reconcile to the
  // income statement beside it. No tax figure, no profit before tax.
  const noTax = data.taxExpense === undefined ? notRead ?? notCaptured('Tax expense') : null;
  const pbt = data.netProfit + (data.taxExpense ?? 0);
  // Net operating assets = Total Assets - Cash - Current Liabilities
  const netOperatingAssets = data.totalAssets - data.cash - data.currentLiabilities;

  // INVENTORY DAYS IS INVENTORY OVER COST OF SALES, so its base is cost of
  // sales — not inventory. A company that holds no stock has a turnover with
  // no meaning and an inventory-days figure of exactly nil, and its cash
  // conversion cycle is its debtor days less its creditor days. Where stock
  // is held the figure is inventory over cost of sales times the window's
  // days. Nil stock is nil days whatever the window: no day count is taken.
  const days = windowDays(data);
  // No inventory classification: nil stock is not established, so neither
  // the days nor the cycle stand on it — the board pack's rule, one rule.
  const unclassified = data.inventoryClassified === false;
  const inventoryDays = given('inventoryDays', unclassified ? NO_INVENTORY_CLASSIFIED
    : data.costOfSales <= 0 ? notPositive('Cost of sales')
    : data.inventory < 0 ? notPositive('Inventory')
    : data.inventory === 0 || days !== null ? null : PERIOD_LENGTH_NOT_MEASURED,
    () => (data.inventory > 0 && days !== null ? daysOver(data.inventory, data.costOfSales, days) : 0));
  const { debtorDays, creditorDays } = base;
  const cycleParts = debtorDays === null || creditorDays === null || inventoryDays === null;

  const noHeadCount = unusable(data.employeeCount, 'The employee count', 'employees', notRead);
  // "None recorded" would be untrue of a company whose salaries sit in a
  // general operating-expense account: what was looked for is the payroll band.
  const noEmployeeCost = unusable(data.employeeCosts, 'Employee cost', 'employee cost under a payroll classification', notRead);
  // Likewise interest: a company that books it to an operating-expense account
  // has interest, just none under a finance-cost classification.
  const noInterest = interestExp < 0 ? INTEREST_IS_NET_CREDIT
    : unusable(data.interestExpense, 'Interest expense', 'interest expense under a finance-cost classification', notRead);
  // Cover on NET interest: no base where nothing was paid, and none either
  // where more was earned than paid — which is not "no interest recorded".
  const noNetInterest = noInterest ?? (netInterest > 0 ? null : NET_INTEREST_IS_INCOME);
  // REVENUE ON TOP IS STILL A REVENUE BASE. A turnover or a per-head figure
  // with non-positive revenue in its numerator printed "Asset Turnover
  // (1.73)×". Revenue is checked first, as for the margins. PBIT and EBITDA
  // per employee follow the margins too: on non-positive revenue that profit
  // is the reversal of sales, not the output of the staff.
  const revenueFirst = (problem: string | null): string | null =>
    (data.revenue > 0 ? problem : notPositive('Revenue'));
  const salesOver = (key: string, base: number, baseName: string): number | null =>
    given(key, revenueFirst(base > 0 ? null : notPositive(baseName)), () => r2(safeDiv(data.revenue, base)));
  const perEmployee = (key: string, numerator: number): number | null =>
    given(key, revenueFirst(noHeadCount), () => r2(safeDiv(numerator, employees)));
  const onNetInterest = (key: string, numerator: number): number | null =>
    given(key, noNetInterest, () => r2(safeDiv(numerator, netInterest)));
  const onRevenue = (problem: string | null): string | null =>
    problem ?? (data.revenue > 0 ? null : notPositive('Revenue'));

  return {
    ...base,
    // Profitability
    ebitda: r2(ebitda),
    ebitdaMargin: on('ebitdaMargin', data.revenue, 'Revenue', () => pct(ebitda, data.revenue)),
    roce: on('roce', capitalEmployed, 'Capital employed', () => pct(ebit, capitalEmployed)),
    pbitMargin: on('pbitMargin', data.revenue, 'Revenue', () => pct(ebit, data.revenue)),
    directMaterialMargin: given('directMaterialMargin',
      onRevenue(unusable(data.directMaterialCosts, 'Direct material cost', 'direct material cost')),
      () => pct(data.revenue - directMaterials, data.revenue)),
    // Leverage
    interestCoverage: given('interestCoverage', noInterest, () => r2(safeDiv(ebit, interestExp))),
    debtRatio: on('debtRatio', data.totalAssets, 'Total assets', () => r2(safeDiv(data.totalLiabilities, data.totalAssets))),
    equityMultiplier: equityFailure ? null : r2(safeDiv(data.totalAssets, data.totalEquity)),
    // Liquidity
    cashRatio: on('cashRatio', data.currentLiabilities, 'Current liabilities',
      () => r2(safeDiv(data.cash, data.currentLiabilities))),
    workingCapital: r2(data.currentAssets - data.currentLiabilities),
    operatingCashFlowRatio: given('operatingCashFlowRatio',
      opCF === undefined ? NO_OPERATING_CASH_FLOW_RATIO
        : data.currentLiabilities > 0 ? null : notPositive('Current liabilities'),
      () => r2(safeDiv(opCF ?? 0, data.currentLiabilities))),
    // Efficiency
    assetTurnover: salesOver('assetTurnover', data.totalAssets, 'Total assets'),
    receivablesTurnover: salesOver('receivablesTurnover', data.accountsReceivable, 'Accounts receivable'),
    payablesTurnover: given('payablesTurnover', data.costOfSales > 0
      ? (data.accountsPayable > 0 ? null : notPositive('Accounts payable')) : notPositive('Cost of sales'),
    () => r2(safeDiv(data.costOfSales, data.accountsPayable))),
    inventoryDays,
    cashConversionCycle: given('cashConversionCycle',
      unclassified ? NO_INVENTORY_CLASSIFIED_CYCLE
        : cycleParts ? dependsOnUnstated('debtor days, inventory days or creditor days') : null,
      () => r2((debtorDays ?? 0) + (inventoryDays ?? 0) - (creditorDays ?? 0))),
    netOperatingAssetTurnover: salesOver('netOperatingAssetTurnover', netOperatingAssets, 'Net operating assets'),
    // Cash Flow
    freeCashFlow: given('freeCashFlow',
      capex === undefined ? NO_FREE_CASH_FLOW : opCF === undefined ? NO_OPERATING_CASH_FLOW_RATIO : null,
      () => r2((opCF ?? 0) - (capex ?? 0))),
    // Coverage (AFS Master v15 — interest coverage variants)
    ebitdaToNetInterest: onNetInterest('ebitdaToNetInterest', ebitda),
    pbtToNetInterest: given('pbtToNetInterest', noTax ?? noNetInterest, () => r2(safeDiv(pbt, netInterest))),
    netProfitToNetInterest: onNetInterest('netProfitToNetInterest', data.netProfit),
    // Employee Productivity (AFS Master v15)
    revenuePerEmployee: perEmployee('revenuePerEmployee', data.revenue),
    pbitPerEmployee: perEmployee('pbitPerEmployee', ebit),
    ebitdaPerEmployee: perEmployee('ebitdaPerEmployee', ebitda),
    employeeCostToRevenue: given('employeeCostToRevenue', onRevenue(noEmployeeCost),
      () => pct(employeeCosts, data.revenue)),
    employeeCostPerHead: given('employeeCostPerHead', noHeadCount ?? noEmployeeCost,
      () => r2(safeDiv(employeeCosts, employees))),
    // Returns
    dividendCover: given('dividendCover', unusable(data.dividendsPaid, 'Dividends paid', 'dividends'),
      () => r2(safeDiv(data.netProfit, dividendsPaid))),
    // An absent dividend is not a nil one: read as zero it printed 100% retained.
    retentionRate: given('retentionRate',
      data.dividendsPaid === undefined ? notCaptured('Dividends paid')
        : data.netProfit > 0 ? null : notPositive('Net profit'),
      () => pct(data.netProfit - dividendsPaid, data.netProfit)),
    effectiveTaxRate: given('effectiveTaxRate',
      noTax ?? (pbt > 0 ? null : notPositive('Profit before tax')),
      () => pct(data.taxExpense ?? 0, pbt)),
    // DuPont Decomposition
    dupontMargin: on('dupontMargin', data.revenue, 'Revenue', () => pct(data.netProfit, data.revenue)),
    dupontTurnover: salesOver('dupontTurnover', data.totalAssets, 'Total assets'),
    dupontLeverage: equityFailure ? null : r2(safeDiv(data.totalAssets, data.totalEquity)),
    notMeaningful: why,
  };
}
