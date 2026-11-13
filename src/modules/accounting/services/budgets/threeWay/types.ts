/**
 * Input and output shapes of the three-way engine (`runThreeWay`, P6 spec §5,
 * §13). Everything a DB service fills is here; the engine reads nothing else.
 *
 * Conventions:
 * - Money is integer CENTS. Balance-sheet buckets are DEBIT-POSITIVE (an asset
 *   is +, a liability or equity balance is −). P&L bands are NATURAL-SIGN
 *   (income +, expense +: a cost of R100 is 10000).
 * - Months are 'YYYY-MM' strings (§13.4). `months` is the version's whole
 *   fiscal year (`versionMonths`), 1..15 contiguous months: month 1 is FY month 1
 *   and the last month is the year end.
 */
import type { CashGroup } from '@/modules/accounting/services/afs/cashFlowClassification';
import type { EntityTypeCode } from '@/lib/entityTypes';
import type { ThreeWayAssumptions } from './assumptionsSchema';

export const BUCKET_KEYS = [
  'cash', 'receivables', 'inventory', 'vatControl', 'fixedAssets', 'accumDepreciation',
  'otherCurrentAssets', 'otherNonCurrentAssets',
  'payables', 'payrollLiabilities', 'incomeTaxPayable', 'dividendsPayable', 'loans',
  'otherCurrentLiabilities', 'otherNonCurrentLiabilities',
  'shareCapital', 'otherEquity', 'retainedEarnings',
] as const;
/**
 * Bucket grain (§5). `vatControl` = vat_input + vat_output net (either side; shown
 * as an asset when debit). `loans` (long_term/non_current liability + loan
 * accounts, current portion included) is shown non-current. `retainedEarnings`
 * includes derived RE (§13.9). Unmapped accounts go to the `other*` buckets and
 * are carried flat.
 */
export type BucketKey = typeof BUCKET_KEYS[number];
export type Buckets = Record<BucketKey, number>;

export const PNL_BANDS = [
  'turnover', 'otherIncome', 'costOfSales', 'payroll', 'depreciation', 'financeCost', 'taxExpense', 'otherOpex',
] as const;
/** P&L bands by canonical subtype (§13.6); natural sign, cents. */
export type PnlBand = typeof PNL_BANDS[number];
export type PnlMonth = Record<PnlBand, number>;

/** One actual month before the version (oldest first, ending the month before `months[0]`). Ex VAT, cents. */
export interface LookbackMonth {
  month: string;
  turnover: number;
  costOfSales: number;
  /** Stock purchases + supplier-paid opex (the creditor-days base). */
  supplierPurchases: number;
}

export interface LoanScheduleLine {
  month: string;
  /** Principal repaid in the month (cents, ≥ 0 normally). */
  principal: number;
  /** Interest per the schedule — a 10c CHECK only; the P&L finance cost is what is paid. */
  interest: number;
}

/** One loan's schedule: an existing loan (`previewSchedule`) or a planned one (`amortise`), keyed by loan / planned id. */
export interface LoanScheduleInput {
  loanId: string;
  lines: readonly LoanScheduleLine[];
}

export type UnmappedBucket =
  | 'otherCurrentAssets' | 'otherNonCurrentAssets' | 'otherCurrentLiabilities' | 'otherNonCurrentLiabilities' | 'otherEquity';

/** An opening account no bucket rule claimed (warned when its balance is not 0). */
export interface UnmappedBalance {
  accountCode: string;
  bucket: UnmappedBucket;
  balance: number;
}

export interface OpeningInput {
  /** 'YYYY-MM-DD' the opening BS is as at (10a). */
  asAt: string;
  /** True when as-at is not the day before months[0] (10a banner). */
  provisional: boolean;
  buckets: Buckets;
  unmapped?: readonly UnmappedBalance[];
}

/** Optional 10c check figures (never overrides). Arrays align with `months`. */
export interface EngineChecks {
  assetRegisterDepreciation?: readonly number[];
}

export interface EngineInput {
  months: readonly string[];
  /** `companies.entity_type` (§13.2: provisional tax only for pty_ltd, ltd, cc, npc). */
  entityType: EntityTypeCode;
  /** Aligned with `months`. */
  pnl: readonly PnlMonth[];
  /** ≥ 12 months wanted; fewer is allowed and warned when the days method walks past it. */
  lookback: readonly LookbackMonth[];
  opening: OpeningInput;
  /** Resolved (scenario chain already merged). */
  assumptions: ThreeWayAssumptions;
  loanSchedules: readonly LoanScheduleInput[];
  checks?: EngineChecks;
}

export type PostingStep =
  | 'sales' | 'other_income' | 'receipts' | 'cogs' | 'purchases' | 'supplier_payments'
  | 'payroll' | 'payroll_remittance' | 'depreciation' | 'finance_cost' | 'loan_drawdown' | 'loan_principal'
  | 'capex' | 'income_tax' | 'provisional_tax' | 'share_issue' | 'dividend_declared' | 'dividend_paid'
  | 'vat_settlement';

/** A ledger line: a bucket, or a P&L band (closes to retained earnings). Debit +, credit −. */
export interface PostingLine {
  account: BucketKey | `pnl.${PnlBand}`;
  amount: number;
}

export interface Posting {
  month: string;
  step: PostingStep;
  /** Required when a line touches `cash`; null otherwise. */
  cashGroup: CashGroup | null;
  lines: readonly PostingLine[];
}

/** Natural-sign sections: assets +, liabilities and equity as credit balances +. */
export interface BalanceSheetSections {
  currentAssets: number;
  nonCurrentAssets: number;
  totalAssets: number;
  currentLiabilities: number;
  nonCurrentLiabilities: number;
  totalLiabilities: number;
  equity: number;
  /** assets − liabilities − equity; 0 every month (I1). */
  check: number;
}

export type DirectCashFlow = Record<CashGroup, number>;

/** Indirect operating cash flow; every line is its CASH effect, so the lines sum to `operating`. */
export interface IndirectCashFlow {
  netProfit: number;
  depreciation: number;
  receivables: number;
  inventory: number;
  payables: number;
  payrollLiabilities: number;
  /** VAT control movement excluding VAT paid on capex (that cash is investing). */
  vat: number;
  incomeTax: number;
  operating: number;
}

export interface CashFlowMonth {
  openingCash: number;
  direct: DirectCashFlow;
  operating: number;
  investing: number;
  financing: number;
  net: number;
  closingCash: number;
  indirect: IndirectCashFlow;
}

export interface MonthResult {
  month: string;
  pnl: PnlMonth & { netProfit: number };
  closing: Buckets;
  balanceSheet: BalanceSheetSections;
  cashFlow: CashFlowMonth;
}

/** One VAT period's net due (liability-positive; < 0 = refund) and when it settles. */
export interface VatSettlement {
  periodStart: string;
  periodEnd: string;
  net: number;
  settleMonth: string;
  /** False when settleMonth is after the version (left on the balance sheet). */
  settled: boolean;
}

export type TaxEventKind = 'irp6_first' | 'irp6_second' | 'top_up';
export interface TaxEvent { month: string; kind: TaxEventKind; amount: number }

export interface Runway {
  minimumCash: number;
  /** First month whose closing cash < minimumCash; null when none. */
  firstBelowMinimum: string | null;
  minCash: number;
  minCashMonth: string;
}

export type OutsideMonthsList = 'capex' | 'loans.planned' | 'equity.shareIssues' | 'equity.dividends';

/** An assumption entry (or its payment) skipped because a date is outside the version; `detail` says exactly what. */
export interface OutsideMonthsEntry {
  list: OutsideMonthsList;
  id: string;
  /** 'entry' = nothing of it posted; 'payment' = declared inside, paid after the version (stays payable). */
  skipped: 'entry' | 'payment';
  detail: string;
}

/** A residual flow that came out negative (kept so the balance sheet holds; shown so a reviewer sees it). */
export type ResidualFlow = 'receipts' | 'stock_purchases' | 'supplier_payments';

export type ThreeWayWarning =
  | { code: 'opening_provisional'; asAt: string }
  | { code: 'opening_cent_difference'; cents: number }
  | { code: 'negative_cash'; months: string[] }
  | { code: 'unmapped_balance'; accounts: UnmappedBalance[] }
  | { code: 'depreciation_check'; budgeted: number; check: number }
  | { code: 'interest_check'; budgeted: number; check: number }
  | { code: 'lookback_short'; series: 'receivables' | 'payables' | 'inventory'; months: string[] }
  | { code: 'outside_months'; entries: OutsideMonthsEntry[] }
  | { code: 'loan_schedule_missing'; loanIds: string[] }
  | { code: 'provisional_tax_not_applicable'; entityType: EntityTypeCode }
  /** A manual top-up offset that differs from SARS (7 after a February year end, else 6). */
  | { code: 'top_up_offset_not_sars'; value: 6 | 7; sars: 6 | 7 }
  /** A debit opening on a statutory liability: carried flat, never refunded as cash. */
  | { code: 'opening_debit_carried'; bucket: 'payrollLiabilities' | 'incomeTaxPayable'; amount: number }
  | { code: 'negative_flow'; month: string; flow: ResidualFlow; amount: number };

export interface FiscalInfo {
  /** Last month of the version (the year end). */
  yearEnd: string;
  /** The month before months[0] (the prior year end; the top-up is counted from it). */
  priorYearEnd: string;
  /** FY month index of each month, 1-based. */
  fyMonthIndex: number[];
}

export interface EngineOutput {
  months: MonthResult[];
  opening: { asAt: string; provisional: boolean; buckets: Buckets; balanceSheet: BalanceSheetSections };
  postings: Posting[];
  runway: Runway;
  warnings: ThreeWayWarning[];
  vatSettlements: VatSettlement[];
  taxEvents: TaxEvent[];
  fiscal: FiscalInfo;
}

/** All-zero buckets. */
export function emptyBuckets(): Buckets {
  return Object.fromEntries(BUCKET_KEYS.map(k => [k, 0])) as Buckets;
}

/** All-zero P&L month. */
export function emptyPnl(): PnlMonth {
  return Object.fromEntries(PNL_BANDS.map(k => [k, 0])) as PnlMonth;
}
