/**
 * The Budget vs Actual tracking engine's shapes (budgets P3, spec
 * `docs/plans/budgets/P3-tracking-spec.md` §2 and §4).
 *
 * Money is rands rounded to the cent by the engine. `null` means ABSENT (no
 * budget, no version), never zero: a budgeted zero is `0`.
 */
import type { FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import type { ReportYearOption } from '@/modules/accounting/services/reports/budgetReportYear';
import type { Band } from '../grid/subtotals';

export type TrackingPeriod = 'month' | 'quarter' | 'ytd' | 'fy' | 'custom';

export const TRACKING_PERIODS: readonly TrackingPeriod[] = ['month', 'quarter', 'ytd', 'fy', 'custom'];

/** A refusal the caller can act on; `status` is the HTTP answer. */
export class TrackingError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'TrackingError';
  }
}

export interface TrackingWindowParams {
  period: TrackingPeriod;
  /** 'YYYY-MM' (period=month). */
  month?: string;
  /** A registry label (quarter, ytd, fy). */
  fiscalYear?: number;
  /** 1..5 (period=quarter). */
  quarter?: number;
  /** 'YYYY-MM' (period=custom). */
  from?: string;
  to?: string;
}

/** The dimension levels a group of bullets is cut by. */
export type TrackingGroupBy = 'cc1' | 'cc2' | 'bu';

export interface TrackingParams extends TrackingWindowParams {
  versionId?: string;
  /** Explicit levels, ANDed: `jl.cc1_id`, `jl.cc2_id`, `jl.bu_id`. */
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
  /** Either level (`cc1_id = X OR cc2_id = X`), the statement pages' meaning; for the comparator (PR-C). */
  costCentreId?: string;
  groupBy?: TrackingGroupBy;
}

/** The actuals filter as SQL reads it. */
export interface TrackingFilter {
  cc1?: string;
  cc2?: string;
  bu?: string;
  costCentre?: string;
}

/** One financial year's part of a window. */
export interface WindowYear {
  fiscalYear: number;
  months: string[];
}

export interface TrackingWindow {
  period: TrackingPeriod;
  /** 'Q5 (2 months)', 'FY2027', '2026-10', ... */
  label: string;
  /** Inclusive, always a 1st ... a month end (whole months). Empty window: end is the day before start. */
  startDate: string;
  endDate: string;
  /** 'YYYY-MM' months of the window, in order. */
  months: string[];
  /** FY*: the label of the financial year holding the window's end (the chosen year when not started). */
  fiscalYear: number;
  fy: FiscalYearRecord;
  /** Every financial year the window touches, with its months inside the window. */
  years: WindowYear[];
  /** The month holding today, when the window contains it. */
  inProgressMonth: string | null;
  /** Year to date of a year that has not started: an empty window. */
  notStarted: boolean;
}

/** The budget grid's band keys (`budgets/grid/subtotals.ts`), so the two budget surfaces share one set. */
export type TrackingBandKey = Band;
export type TrackingTotalKey = 'gross_profit' | 'operating_profit' | 'net_profit';

/** The figure fields every line and band carries. */
export interface TrackingFigures {
  actual: number;
  /** Null: unbudgeted (no included budget row in the window). */
  budget: number | null;
  /** actual − budget (the movement sign); null when unbudgeted. */
  variance: number | null;
  /** variance / |budget| × 100; null when the budget is 0 or absent. */
  variancePct: number | null;
  /** By polarity; null when unbudgeted. */
  favourable: boolean | null;
  /** Actuals to the projection cutoff plus budget after it. */
  projected: number;
  /** Σ budget over every month of FY*; null when FY* holds no included budget for it. */
  fyBudget: number | null;
  /** projected − fyBudget; null with fyBudget. */
  projVariance: number | null;
  projFavourable: boolean | null;
  /** Budget set ABOVE the filter (coarser grain) in the window: never in `budget`, never apportioned.
   *  On a profit total (GP / OP / NP) it is netted by polarity, income − expense, like the budget.
   *  Null with the window budget (a window month in a year with no version). */
  unallocatedBudget: number | null;
}

export interface TrackingMonth {
  month: string;
  actual: number;
  budget: number | null;
  /** No included budget this month, but one set above the filter. */
  budgetAboveFilter: boolean;
  variance: number | null;
  favourable: boolean | null;
}

export interface TrackingLine extends TrackingFigures {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: 'revenue' | 'expense';
  band: TrackingBandKey;
  /** The account's only budget in the window is set above this filter ("budget set above this filter"). */
  budgetAboveFilter: boolean;
  monthly: TrackingMonth[];
}

export interface TrackingBand extends TrackingFigures {
  key: TrackingBandKey | TrackingTotalKey;
  label: string;
  kind: 'band' | 'total' | 'grand';
  polarity: 'income' | 'expense';
}

export interface TrackingMemberRef {
  id: string;
  code: string;
  name: string;
}

export interface TrackingVersionRef {
  id: string;
  name: string;
  kind: string;
  status: string;
  isPrimary: boolean;
}

/** One bullet: a member's net profit, or the untagged / company-level remainder (memberId null). */
export interface TrackingMember {
  memberId: string | null;
  code: string;
  name: string;
  actual: number;
  budget: number | null;
  variance: number | null;
  favourable: boolean | null;
}

/** A notice figure kept per polarity: income and expense are never summed together (D1). */
export interface ByPolarity { income: number; expense: number }

export interface TrackingNotices {
  /** Accounts with posted movement, no included budget, and none above the filter either. */
  unbudgetedCount: number;
  /** Σ actual of those accounts, per polarity (natural sign). */
  unbudgetedActual: ByPolarity;
  /** Σ unallocated (coarser) budget over every line, per polarity; null when the window budget is absent. */
  unallocatedBudget: ByPolarity | null;
  /** FY* has no version, or an empty one (no rows). */
  noVersion: boolean;
  /** Every window year (and FY*) without a version or with an empty one (cross-FY windows can have a gap). */
  noVersionYears: number[];
}

export interface TrackingProjectionInfo {
  fiscalYear: number;
  /** Last day whose actuals the projection uses (FY* start − 1 day when none). */
  cutoff: string;
  actualMonths: string[];
  budgetMonths: string[];
}

export interface BudgetTrackingReport {
  window: {
    period: TrackingPeriod;
    label: string;
    startDate: string;
    endDate: string;
    months: string[];
    fiscalYear: number;
    /** The month holding today, and the latest posting in it up to TODAY (a forward-dated journal is not "posted through"). */
    inProgress: { month: string; actualsTo: string | null } | null;
    /** Latest posted entry date anywhere in the window, in progress or not: P0's `postedThrough` (PR-C facade parity). */
    postedThrough: string | null;
    notStarted: boolean;
  };
  /** FY*'s version; null when FY* has none. */
  version: TrackingVersionRef | null;
  /** Cross-FY window only: each year's version. */
  versionsByFy?: Record<number, { id: string; name: string; kind: string; status: string }>;
  filter: { cc1?: TrackingMemberRef; cc2?: TrackingMemberRef; bu?: TrackingMemberRef; costCentre?: TrackingMemberRef };
  projection: TrackingProjectionInfo;
  lines: TrackingLine[];
  bands: TrackingBand[];
  notices: TrackingNotices;
  members?: TrackingMember[];
  years: ReportYearOption[];
}
