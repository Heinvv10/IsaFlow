import type { IncomeStatementSubtypeDisclosure } from '../services/reports/incomeStatementDisclosure';

/**
 * PRD-060: FibreFlow Accounting Module
 * General Ledger Report Type Definitions
 *
 * Split from gl.types.ts to stay within the 300-line limit.
 * Account/enum/journal types remain in gl.types.ts.
 */

// ── Reports ──────────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  accountType: string;
  normalBalance: 'debit' | 'credit';
  /** Closing balance, reported on the account's balance side (net, not gross turnover). */
  debitBalance: number;
  creditBalance: number;
  priorDebitBalance?: number;
  priorCreditBalance?: number;
  /** Balance at the start of the reporting range. opening + movement = closing. */
  openingDebit?: number;
  openingCredit?: number;
  /** Gross debit / credit turnover within the reporting range. */
  periodDebit?: number;
  periodCredit?: number;
  /**
   * True for a COMPUTED line with no journal behind it — currently only the
   * retained-earnings brought-forward row. Anything tying this report to the
   * ledger must exclude it; anything displaying it must say it is derived.
   */
  derived?: boolean;
}

/**
 * Trial Balance report container.
 * The account lines are exposed under the `rows` key (canonical; never `accounts`).
 * See GET /api/accounting/reports-trial-balance.
 *
 * The balanced assertion (`difference` / `balanced`) is computed ONCE, in
 * `getTrialBalanceReport`. It is part of the report, not something each caller
 * derives: the UI, the CSV export and the MCP tool each rolling their own is how
 * a partial trial balance came to be stamped "Difference R0.00 · Balanced".
 * `accountCount` states the scope that assertion covers.
 */
export interface TrialBalanceReport {
  fiscalPeriodId: string;
  /** Alias of `periodEnd`, kept for callers that read `asAtDate`. */
  asAtDate: string;
  periodStart: string;
  periodEnd: string;
  /**
   * First day of the fiscal year the income-statement rows are measured from
   * (`companies.financial_year_start`). Balance-sheet rows ignore it — they are
   * cumulative from inception.
   */
  fiscalYearStart: string;
  costCentreId?: string;
  /** Canonical key for account lines — always `rows`, never `accounts`. */
  rows: TrialBalanceRow[];
  /** Rows returned. The balanced assertion below describes exactly these. */
  accountCount: number;
  totalDebit: number;
  totalCredit: number;
  /** totalDebit − totalCredit, rounded to cents. Zero on a healthy ledger. */
  difference: number;
  /** True when |difference| is within half a cent. Never recompute this. */
  balanced: boolean;
}

export interface IncomeStatementLineItem {
  accountCode: string;
  accountName: string;
  amount: number;
  priorAmount?: number;
  variance?: number;
  variancePct?: number;
}

export interface IncomeStatementReport {
  periodStart: string;
  periodEnd: string;
  projectId?: string;
  costCentreId?: string;
  revenue: IncomeStatementLineItem[];
  /** Revenue-typed accounts whose subtype is other income — NOT trading revenue. */
  otherIncome: IncomeStatementLineItem[];
  costOfSales: IncomeStatementLineItem[];
  operatingExpenses: IncomeStatementLineItem[];
  /** Finance cost, tax and other expense — reported below the operating line. */
  otherExpenses: IncomeStatementLineItem[];
  /** Turnover only. Other income is reported separately, below gross profit. */
  totalRevenue: number;
  totalOtherIncome: number;
  totalCostOfSales: number;
  totalOperatingExpenses: number;
  totalOtherExpenses: number;
  /** Turnover less cost of sales. Trading only. */
  grossProfit: number;
  /**
   * Gross profit PLUS other income, less operating expenses. Other income is
   * above the operating line; only finance cost and tax sit below it. Written
   * out because "gross profit less operating expenses" is the wrong formula
   * that caused B75's re-divergence.
   */
  operatingProfit: number;
  netProfit: number;
  /**
   * Gross profit and net profit as a percentage of turnover. Null when there
   * is no turnover: a margin on no revenue is undefined, not zero. Computed
   * here rather than in a component so every surface quotes the same ratio of
   * the same bands.
   */
  grossMarginPct?: number | null;
  netMarginPct?: number | null;
  // Comparative totals (populated when compare period requested)
  comparativePeriod?: { start: string; end: string };
  priorTotalRevenue?: number;
  priorTotalOtherIncome?: number;
  priorTotalCostOfSales?: number;
  priorGrossProfit?: number;
  priorOperatingProfit?: number;
  priorTotalOperatingExpenses?: number;
  priorTotalOtherExpenses?: number;
  priorNetProfit?: number;
  /**
   * Accounts whose subtype the classifier does not recognise, and which are
   * therefore banded by fallback rather than by classification. Null when there
   * are none. See `../services/reports/incomeStatementDisclosure.ts` — this is
   * why a gross margin on this report can be materially wrong while every
   * total on it adds up.
   */
  subtypeDisclosure?: IncomeStatementSubtypeDisclosure | null;
  /**
   * The same, for the comparative period. A variance column is a difference
   * between two independently mis-banded numbers, and the current period's
   * banner says nothing about the prior one.
   */
  priorSubtypeDisclosure?: IncomeStatementSubtypeDisclosure | null;
}

export interface BalanceSheetLineItem {
  accountCode: string;
  accountName: string;
  balance: number;
  priorBalance?: number;
  variance?: number;
  variancePct?: number;
}

export interface BalanceSheetReport {
  asAtDate: string;
  costCentreId?: string;
  assets: BalanceSheetLineItem[];
  liabilities: BalanceSheetLineItem[];
  equity: BalanceSheetLineItem[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  // Comparative (populated when compare date requested)
  compareDate?: string;
  priorTotalAssets?: number;
  priorTotalLiabilities?: number;
  priorTotalEquity?: number;
}

export interface VAT201Box {
  box: string;
  label: string;
  amount: number;
  transactions?: VAT201Transaction[];
}

export interface VAT201Transaction {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  sourceDocument?: string;
  amount: number;
}

export interface VATReturnReport {
  periodStart: string;
  periodEnd: string;
  // Section A — Output Tax
  outputBoxes: VAT201Box[];
  totalOutputTax: number;
  // Section B — Input Tax
  inputBoxes: VAT201Box[];
  totalInputTax: number;
  // Net
  netVAT: number;
  // Legacy compatibility
  outputVAT: number;
  inputVAT: number;
  outputDetails: Array<{ accountCode: string; accountName: string; amount: number }>;
  inputDetails: Array<{ accountCode: string; accountName: string; amount: number }>;
  standardRatedSupplies: number;
  standardRatedPurchases: number;
}

export interface ProjectProfitabilityReport {
  projectId: string;
  projectName: string;
  periodStart: string;
  periodEnd: string;
  revenue: number;
  costs: number;
  profit: number;
  margin: number;
  revenueLines: Array<{ accountCode: string; accountName: string; amount: number }>;
  costLines: Array<{ accountCode: string; accountName: string; amount: number }>;
}

export interface CashFlowReport {
  periodStart: string;
  periodEnd: string;
  operatingActivities: Array<{ description: string; amount: number }>;
  investingActivities: Array<{ description: string; amount: number }>;
  financingActivities: Array<{ description: string; amount: number }>;
  totalOperating: number;
  totalInvesting: number;
  totalFinancing: number;
  netCashFlow: number;
  openingBalance: number;
  closingBalance: number;
}
