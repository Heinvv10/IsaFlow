/**
 * The figure set behind a comparative pack: actual, prior period, budget.
 *
 * The shipped board pack was rejected for showing a single actual-only column,
 * and this file is the reason it had only one: the pack's figure supply fetched
 * `getReportPackInput` once and had nothing to compare against. Nothing here
 * computes a figure — every number is copied from the service that owns it, so
 * the comparative columns cannot drift from the statement beside them.
 *
 * Three rules the columns depend on:
 *   1. The comparative is a CALENDAR period, from `priorPeriod` — March
 *      compares against February as itself, not a rolling 31 days ending
 *      28 February. No Date is constructed here, for the reason given there.
 *   2. An absent prior is `null`, never zeros: a zeroed prior column prints
 *      "-100%" against a real current figure, which is a false statement about
 *      the business rather than an absent comparative.
 *   3. An absent budget is `null`, never a zero column — `getBudgetVariance`
 *      returns a result with an EMPTY `rows` array for a company with no budget
 *      (Brightsphere), and a caller must not have to know that.
 *
 * THE BUDGET IS THE TRACKING ENGINE'S (budgets P3 PR-E, spec §4 Packs), read the
 * way the statement Budget column reads it (`partialWindow: 'absent'`): whole
 * months only, the primary version unless one is named, and each income-statement
 * band's budget and profit total COPIED from the engine (`bands`), never summed
 * from accounts here — under the engine's rules a band can have no budget while
 * accounts under it do. The pack prints the engine's budget beside its OWN actual,
 * so the two must be the same ledger read: the engine's band actuals are checked
 * against the pack's, and on any disagreement the budget is withheld (logged).
 */

import { log } from '@/lib/logger';
import { withSavepoint } from '@/lib/neon';
import { failedReadLabel, isFailedRead } from '@/modules/accounting/services/packs/packFailedRead';
import {
  getReportPackInput,
  type ReportPackFigures,
} from '@/modules/accounting/services/reports/reportPackDataService';
import {
  priorPeriod,
  type PeriodWindow,
} from '@/modules/accounting/services/reports/priorPeriod';
import {
  getBudgetVariance,
  type BudgetVarianceTrackedResult,
} from '@/modules/accounting/services/reports/budgetVarianceService';
import type { TrackingBandKey } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { PACK_BUDGET_BAND, type PackBudgetRowKey } from './packBudgetBands';
import { operatingProfitOf } from './packMetricReads';


/** One budgeted account, in the pack's own vocabulary. */
export interface PackBudgetRow {
  accountCode: string;
  accountName: string;
  accountType: string;
  budget: number;
  actual: number;
  variance: number;
  /** null when the budget is zero (budgets P0): there is nothing to be a percentage of. */
  variancePct: number | null;
}

/**
 * What a pack page needs off a budget, and no more. The full
 * `BudgetVarianceResult` also carries the unbudgeted split and the month keys
 * it summed over; passing it through whole would invite a page to render a
 * figure this file has made no promise about.
 */
export interface PackBudgetFigures {
  fiscalYear: number;
  /** The version read (the primary unless one was named). */
  version: { name: string; status: string };
  /** Each income-statement row's budget, the engine's band or profit total; null where
   *  the engine states none (no account in it budgeted, or one budgeted for part of the window). */
  bands: Record<PackBudgetRowKey, number | null>;
  /** Accounts with posted movement in the window and no budget: their budget counts as nil. */
  unbudgetedCount: number;
  /** Net profit (revenue − expenses) over EVERY account with a budget or
   *  movement, budgeted or not (budgets P0, D11): it does not foot to Σ `rows`,
   *  which holds the budgeted accounts only. Nothing renders it yet. */
  totals: { budget: number | null; actual: number; variance: number | null };
  rows: PackBudgetRow[];
  /** Latest posted entry date inside the window, or null when nothing posted. */
  postedThrough: string | null;
}

export interface PackFigureSet {
  current: ReportPackFigures;
  currentWindow: PeriodWindow;
  /** null where the prior window carries no ledger — never a zeroed column. */
  prior: ReportPackFigures | null;
  priorWindow: PeriodWindow;
  /** null where the company has no budget for the window — Brightsphere. */
  budget: PackBudgetFigures | null;
}

/**
 * Whether these figures represent a company that existed in the window.
 *
 * `getFinancialFigures` does not throw on an empty ledger — it returns zeros —
 * so a period before the first posted journal is indistinguishable from a real
 * one by shape alone. Every P&L line AND every balance-sheet position being
 * zero means nothing was posted through that date at all. A dormant month with
 * assets on the books is NOT this case and is kept: it is a real comparative.
 */
function carriesLedger(figures: ReportPackFigures): boolean {
  // `otherIncome` and `otherExpenses` are optional on `ReportPackInput`, so
  // they are coalesced: `undefined !== 0` is true and would report a ledger
  // that is not there.
  return (
    figures.revenue !== 0 ||
    figures.costOfSales !== 0 ||
    figures.operatingExpenses !== 0 ||
    (figures.otherIncome ?? 0) !== 0 ||
    (figures.otherExpenses ?? 0) !== 0 ||
    figures.netProfit !== 0 ||
    figures.totalAssets !== 0 ||
    figures.totalLiabilities !== 0 ||
    figures.totalEquity !== 0
  );
}

async function fetchPrior(
  companyId: string,
  companyName: string,
  window: PeriodWindow,
): Promise<ReportPackFigures | null> {
  let figures: ReportPackFigures;
  try {
    // In its own savepoint: a caught failure otherwise leaves the request's
    // transaction aborted and the budget read below refused. See packFailedRead.
    figures = await withSavepoint('pack_prior_period', () =>
      getReportPackInput(companyId, companyName, window.start, window.end));
  } catch (error) {
    if (!isFailedRead(error)) throw error;
    log.warn(
      'packFigureSet: prior period unavailable, comparative column omitted',
      { companyId, from: window.start, to: window.end, error: failedReadLabel(error) },
      'packs',
    );
    return null;
  }
  if (!carriesLedger(figures)) {
    log.warn(
      'packFigureSet: prior period carries no ledger, comparative column omitted',
      { companyId, from: window.start, to: window.end },
      'packs',
    );
    return null;
  }
  return figures;
}

/** The pack's own actual for each engine band (natural sign, as the engine states them). */
function packBandActuals(f: ReportPackFigures): Record<TrackingBandKey, number> {
  return {
    turnover: f.revenue,
    cost_of_sales: f.costOfSales,
    other_income: f.otherIncome ?? 0,
    operating_expense: f.operatingExpenses,
    other_expense: f.otherExpenses ?? 0,
  };
}

/** Half a cent: both sides are rounded to the cent. */
const SAME_CENT = 0.005;

/** The bands where the engine's actual is not the pack's: printing its budget beside the pack's actual would mix two ledgers. */
function disagreeingBands(result: BudgetVarianceTrackedResult, current: ReportPackFigures): string[] {
  const own = packBandActuals(current);
  return result.bands
    .filter((b): b is typeof b & { key: TrackingBandKey } => b.key in own)
    .filter((b) => Math.abs(b.actual - own[b.key]) > SAME_CENT)
    .map((b) => b.key);
}

function toPackBudget(
  result: BudgetVarianceTrackedResult,
  current: ReportPackFigures,
  logFields: Record<string, unknown>,
): PackBudgetFigures | null {
  // No budgeted account, a year in the window with no budget, or a window that cuts a budget month:
  // the engine states no window budget, and a column of dashes is not a budget column.
  if (result.rows.length === 0 || result.budgetAbsentYears.length > 0 || result.splitsMonth || result.version === null) {
    return null;
  }
  const disagree = disagreeingBands(result, current);
  if (disagree.length > 0) {
    log.warn('packFigureSet: the budget engine and the pack read different actuals, budget column omitted',
      { ...logFields, bands: disagree }, 'packs');
    return null;
  }
  const byKey = new Map(result.bands.map((b) => [b.key, b.budget]));
  const bands = Object.fromEntries(
    Object.entries(PACK_BUDGET_BAND).map(([row, band]) => [row, byKey.get(band) ?? null]),
  ) as Record<PackBudgetRowKey, number | null>;
  return {
    fiscalYear: result.fiscalYear,
    version: { name: result.version.name, status: result.version.status },
    bands,
    unbudgetedCount: result.unbudgeted.filter((l) => l.actual_amount !== 0).length,
    totals: result.totals,
    rows: result.rows.map((r) => ({
      accountCode: r.account_code,
      accountName: r.account_name,
      accountType: r.account_type,
      budget: r.budget_amount,
      actual: r.actual_amount,
      variance: r.variance,
      variancePct: r.variance_pct,
    })),
    postedThrough: result.postedThrough,
  };
}

async function fetchBudget(
  companyId: string,
  window: PeriodWindow,
  current: ReportPackFigures,
  versionId: string | undefined,
): Promise<PackBudgetFigures | null> {
  try {
    const result = await withSavepoint('pack_budget', () =>
      getBudgetVariance(companyId, window.start, window.end, { partialWindow: 'absent', ...(versionId ? { versionId } : {}) }));
    return toPackBudget(result, current, { companyId, from: window.start, to: window.end });
  } catch (error) {
    if (!isFailedRead(error)) throw error;
    // A missing budget must not cost the pack its actual and prior columns.
    log.warn(
      'packFigureSet: budget unavailable, budget column omitted',
      { companyId, from: window.start, to: window.end, error: failedReadLabel(error) },
      'packs',
    );
    return null;
  }
}

export async function buildPackFigureSet(
  companyId: string,
  companyName: string,
  from: string,
  to: string,
  /** The budget version; the primary of each year when omitted. */
  opts: { versionId?: string } = {},
): Promise<PackFigureSet> {
  const currentWindow: PeriodWindow = { start: from, end: to };
  const priorWindow = priorPeriod(from, to);

  // Sequential, not Promise.all. Under `withAuth` a request-scoped transaction
  // is in flight and `sql` routes every query through the ONE pg client held in
  // the async-local store (see the `als.getStore()?.client` branch in
  // lib/neon/query.ts). Concurrent queries on a single pg connection are a known
  // hazard in this repo, so these must not be raced. The call order the tests
  // assert is a consequence of this, not the reason for it.
  const current = await getReportPackInput(companyId, companyName, from, to);
  const prior = await fetchPrior(companyId, companyName, priorWindow);
  const budget = await fetchBudget(companyId, currentWindow, current, opts.versionId);

  return { current, currentWindow, prior, priorWindow, budget };
}
