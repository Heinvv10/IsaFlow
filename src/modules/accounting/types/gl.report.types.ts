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
  debitBalance: number;
  creditBalance: number;
  priorDebitBalance?: number;
  priorCreditBalance?: number;
}

/**
 * Trial Balance report container.
 * The account lines are exposed under the `rows` key (canonical; never `accounts`).
 * See GET /api/accounting/reports-trial-balance.
 */
export interface TrialBalanceReport {
  asAtDate: string;
  fiscalPeriodId: string;
  /** Canonical key for account lines — always `rows`, never `accounts`. */
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
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
  costOfSales: IncomeStatementLineItem[];
  operatingExpenses: IncomeStatementLineItem[];
  totalRevenue: number;
  totalCostOfSales: number;
  grossProfit: number;
  totalOperatingExpenses: number;
  netProfit: number;
  // Comparative totals (populated when compare period requested)
  comparativePeriod?: { start: string; end: string };
  priorTotalRevenue?: number;
  priorTotalCostOfSales?: number;
  priorGrossProfit?: number;
  priorTotalOperatingExpenses?: number;
  priorNetProfit?: number;
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
