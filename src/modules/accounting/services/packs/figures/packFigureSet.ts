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
 */

import { log } from '@/lib/logger';
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
  type BudgetVarianceResult,
} from '@/modules/accounting/services/reports/budgetVarianceService';

/** One budgeted account, in the pack's own vocabulary. */
export interface PackBudgetRow {
  accountCode: string;
  accountName: string;
  accountType: string;
  budget: number;
  actual: number;
  variance: number;
  variancePct: number;
}

/**
 * What a pack page needs off a budget, and no more. The full
 * `BudgetVarianceResult` also carries the unbudgeted split and the month keys
 * it summed over; passing it through whole would invite a page to render a
 * figure this file has made no promise about.
 */
export interface PackBudgetFigures {
  fiscalYear: number;
  totals: { budget: number; actual: number; variance: number };
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
    figures = await getReportPackInput(companyId, companyName, window.start, window.end);
  } catch (error) {
    log.warn(
      'packFigureSet: prior period unavailable, comparative column omitted',
      { companyId, from: window.start, to: window.end, error: String(error) },
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

function toPackBudget(result: BudgetVarianceResult): PackBudgetFigures | null {
  if (result.rows.length === 0) return null;
  return {
    fiscalYear: result.fiscalYear,
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
): Promise<PackBudgetFigures | null> {
  try {
    return toPackBudget(await getBudgetVariance(companyId, window.start, window.end));
  } catch (error) {
    // A missing budget must not cost the pack its actual and prior columns.
    log.warn(
      'packFigureSet: budget unavailable, budget column omitted',
      { companyId, from: window.start, to: window.end, error: String(error) },
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
): Promise<PackFigureSet> {
  const currentWindow: PeriodWindow = { start: from, end: to };
  const priorWindow = priorPeriod(from, to);

  // Sequential, not Promise.all. Under `withAuth` a request-scoped transaction
  // is in flight and `sql` routes every query through the ONE pg client held in
  // the async-local store (see the `als.getStore()?.client` branch in
  // lib/neon.ts). Concurrent queries on a single pg connection are a known
  // hazard in this repo, so these must not be raced. The call order the tests
  // assert is a consequence of this, not the reason for it.
  const current = await getReportPackInput(companyId, companyName, from, to);
  const prior = await fetchPrior(companyId, companyName, priorWindow);
  const budget = await fetchBudget(companyId, currentWindow);

  return { current, currentWindow, prior, priorWindow, budget };
}
