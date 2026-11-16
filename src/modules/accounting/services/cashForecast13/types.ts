/**
 * Types of the 13-week cash forecast. Money is integer CENTS (signed: + in, − out); dates 'YYYY-MM-DD'
 * on the SAST calendar. Rand strings are rendered at the edge (the page), never here.
 */

export const FORECAST_WEEKS = 13;

/** The VAT refund lag the three-way assumes when no budget says otherwise (budgets/threeWay/assumptionsDefaults.ts). */
export const DEFAULT_REFUND_LAG_MONTHS = 1;

/** What a line is about. Receipts and supplier payments are also what the budget fill tops up. */
export type CashCategory = 'customer_receipts' | 'supplier_payments' | 'payroll' | 'sars' | 'loans' | 'other';

/** How an AR line's expected date was chosen (ruling 2026-11-16). */
export type ArBasis = 'due' | 'history' | 'no_history';

export type LineKind = 'known' | 'estimate' | 'manual' | 'override';

/** One dated cash movement from a source reader. Items with the same `lineKey` form one line. */
export interface KnownItem {
  lineKey: string;
  lineLabel: string;
  category: CashCategory;
  /** The customer or supplier, for netting their unapplied credit (AR and AP items). */
  entityId?: string;
  /** The date the money is expected; a date before today lands in week 1. */
  date: string;
  amountCents: number;
  /** The document it comes from (invoice id, run id, loan id + period, …). */
  ref: string;
  refLabel: string;
  basis?: ArBasis;
  /** True when the amount itself is an estimate (an EMP201 from the latest run, a budgeted VAT remainder). */
  estimate?: boolean;
  flags?: string[];
}

/** A user's own line (PR 2 stores them). `repeat` repeats it from `date` until `until` (inclusive) or the horizon. */
export interface ManualItem {
  id: string;
  date: string;
  amountCents: number;
  description: string;
  category: CashCategory;
  repeat?: { frequency: 'weekly' | 'monthly'; until?: string | null } | null;
}

/**
 * A user's change to one cell of a line (PR 2 stores them). Applied after everything else, in array order.
 *   set:     the cell becomes `amountCents`.
 *   add:     `amountCents` is added to the cell.
 *   move_to: the cell's amount moves to `targetWeek`; or, when `amountCents` is given, that MAGNITUDE (≥ 0, as the
 *            data layer stores it) of it, in the cell's own sign. set/add amounts are signed in the line's sign.
 */
export interface Override {
  lineKey: string;
  weekIndex: number;
  mode: 'set' | 'add' | 'move_to';
  amountCents?: number | null;
  targetWeek?: number | null;
}

/** The three-way budget's direct cash flow for one month (signed cents). */
export interface BudgetMonth {
  month: string;
  customerReceipts: number;
  supplierPayments: number;
}

export interface ForecastWarning {
  code: string;
  source: string;
  message: string;
}

export interface OverdueArSummary {
  /** Overdue open AR expected inside the 13 weeks (disputes and unapplied credit excluded), cents. */
  totalCents: number;
  /** Overdue AR whose history-projected date falls after week 13: not in the forecast. */
  beyondHorizonCents: number;
  invoiceCount: number;
  byBasis: { history: number; no_history: number };
  /** Disputed amounts on open invoices, left out of receipts as the aging leaves them out of its buckets. */
  disputedCents: number;
}

export interface EngineInput {
  today: string;
  openingCents: number;
  items: KnownItem[];
  /** null: no budget lines (no primary version, flag off, or unreadable — the readers say why in `warnings`). */
  budget: BudgetMonth[] | null;
  manualItems: ManualItem[];
  overrides: Override[];
  overdueAR: OverdueArSummary;
  warnings: ForecastWarning[];
}

export interface LineItem {
  ref: string;
  label: string;
  /** The source's own date (before it was moved into week 1). */
  date: string;
  weekIndex: number;
  amountCents: number;
  basis?: ArBasis;
}

export interface ForecastLine {
  key: string;
  label: string;
  category: CashCategory;
  kind: LineKind;
  weekly: number[];
  totalCents: number;
  basis?: ArBasis;
  flags: string[];
  items: LineItem[];
}

export interface ForecastWeek {
  index: number;
  start: string;
  end: string;
  openingCents: number;
  inflowsCents: number;
  outflowsCents: number;
  netCents: number;
  closingCents: number;
}

export interface CashForecast13 {
  today: string;
  weeks: ForecastWeek[];
  lines: ForecastLine[];
  overdueAR: OverdueArSummary;
  warnings: ForecastWarning[];
}
