/**
 * The report pack's input and output shapes. Moved out of
 * `reportPackService.ts` unchanged to keep that file under the 300-line cap;
 * `reportPackService.ts` re-exports every type here, so existing import paths
 * still resolve.
 */

export interface ReportPackInput {
  companyName: string;
  period: string;
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
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  otherIncome?: number;
  otherExpenses?: number;
  /** From the classifier. Falls back to the derived line when absent. */
  operatingProfit?: number;
  /**
   * The period's depreciation and amortisation charge. EBITDA is operating
   * profit plus this; `buildReportPack` did not pass it on, so the management
   * pack's "EBITDA" was operating profit to the rand. Optional only so a
   * hand-built input need not supply it — `getReportPackInput` always does.
   */
  depreciation?: number;
  financingCashFlow?: number;
  /**
   * Net cash from investing activities over the window, signed as cash moved:
   * an outflow is negative. From `getCashFlowDirect` via `getReportPackInput`,
   * with the operating and financing figures beside it. Optional like those
   * two: an input built without a cash flow statement carries none.
   *
   * ITS OWN FIELD, NOT `capitalExpenditure` NEGATED. The direct-method
   * statement has one investing group — acquisitions net of disposals, and
   * investments with them — and does not itemise purchases of assets apart.
   * Carried as capex it would restate every Free Cash Flow that reads that
   * field as "operating less net investing". `capitalExpenditure` therefore
   * stays unpopulated, as it was.
   */
  investingCashFlow?: number;
  /**
   * Interest, tax, employee cost, head count and direct materials for the
   * window, off the ledger (`extendedRatioInputs.readLedgerRatioInputs` via
   * `readReportPackInput`) — the inputs the Financial Analysis screen's
   * ratios use, so the pack states the same figures. All six or none: where
   * the read failed none is set and `ratioInputsUnavailable` says so.
   */
  interestExpense?: number;
  interestIncome?: number;
  employeeCosts?: number;
  employeeCount?: number;
  taxExpense?: number;
  directMaterialCosts?: number;
  /** Set only when those six were asked for and could not be read. */
  ratioInputsUnavailable?: string;
}

export type PackType = 'board' | 'management' | 'monthly';

export interface PackSectionConfig {
  type: string;
  title: string;
}

export interface PackSection {
  type: string;
  title: string;
  data: Record<string, unknown>;
}

export interface ReportPack {
  type: PackType;
  companyName: string;
  period: string;
  generatedAt: string;
  sections: PackSection[];
}
