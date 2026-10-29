/**
 * Fetches the two comparators the statement pages did not previously have —
 * the 12-month trend series and the budget column — and hands back one
 * `apply` that decorates a `StatementRow[]` with whichever are switched on.
 *
 * The fetch is keyed on the checkbox, not on the page load: a statement is
 * two SQL aggregates on its own, and pulling twelve months of movements plus
 * the whole budget on every render of a report nobody asked to compare is a
 * cost paid by every user for a column most of them never turn on.
 *
 * A FAILED FETCH IS NOT AN EMPTY COLUMN. Both errors are reported back to the
 * caller so the page can say so: an empty trend cell already MEANS "this
 * account has no series" (retained earnings), and an empty budget column
 * already means "no budget was captured". Rendering a network failure as
 * either one states something about the ledger that nobody checked.
 *
 * The budget column follows the statement's dimension filter (budgets P3 PR-C):
 * `costCentreId` (either level) and `businessUnitId` go to the comparator, as
 * the statement sends them. Period and filter changes are COALESCED: the fetch
 * waits BUDGET_COALESCE_MS after the last change, so typing a date or stepping
 * through periods costs the company's report limit one request, not one per
 * keystroke. A refusal (429) is its own state with the wait and a retry,
 * never "failed" and never "none".
 *
 * Nothing is derived here. `applyTrend` and `applyBudgetComparator` own the
 * mapping, and they COPY figures — see `statementRows/comparators.ts`.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { ByPolarity } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import type { BudgetVarianceTracked, TrackedLine } from '@/modules/accounting/services/reports/budgetVarianceTracked';
import type { AccountTrends } from '@/modules/accounting/services/reports/trendRowsService';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import {
  applyBudgetComparator, applyTrend, hasBudgetData,
} from '@/modules/accounting/services/reports/statementRows/comparators';
import { applyBudgetBands, withBudgetedLines } from '@/modules/accounting/services/reports/statementRows/budgetComparatorBands';

/** What the budget fetch has established so far. `unknown` covers both "not
 *  asked for" and "still in flight"; `failed` must never be shown as `none`;
 *  `limited` is a refusal by the report limiter, which a retry can answer. */
export type BudgetState = 'unknown' | 'failed' | 'limited' | 'none' | 'available';

/** What the budget fetch said about the window beyond its lines. */
export interface BudgetInfo {
  /** Years of the window with no budget in it. */
  budgetAbsentYears: number[];
  /** Every financial year with months in the window. */
  windowYears: number[];
  /** Budget set above the dimension filter, per polarity; null when the window budget is absent. */
  unallocatedBudget: ByPolarity | null;
  /** Accounts budgeted for only part of the window, whose Budget is blank. */
  partialBudgetCount: number;
  /** The window cuts a budget month: no window budget (budgets are set by whole month). */
  splitsMonth: boolean;
  /** The limiter's wait, when `budgetState` is `limited` and the server named one. */
  retryAfterSecs: number | null;
}

/** How long the budget fetch waits after the last period or filter change. */
export const BUDGET_COALESCE_MS = 350;

export interface StatementComparators {
  apply: (rows: StatementRow[]) => StatementRow[];
  budgetState: BudgetState;
  budgetInfo: BudgetInfo;
  /** Asks for the budget again (after a refusal or a failure). */
  retryBudget: () => void;
  trendFailed: boolean;
  trendLoading: boolean;
  budgetLoading: boolean;
}

export interface StatementComparatorOptions {
  trend: boolean;
  /**
   * Whether to fetch the budget column. OMITTED means no: a budget is a P&L
   * figure, so the balance sheet has no budget to ask for, and it should not
   * have to pass `budget: false` plus two period bounds that are never read
   * to say so. Every option the budget fetch needs is optional with it.
   */
  budget?: boolean;
  /** Last day of the trend window — the statement's own period end / as-at. */
  asOf: string;
  /** `movement` for P&L accounts, `balance` for balance-sheet accounts. */
  basis: 'movement' | 'balance';
  /** Required when `budget` is on; the budget fetch's window. */
  periodStart?: string;
  periodEnd?: string;
  /** The statement's dimension filter, as it sends it ('' = none). */
  costCentreId?: string;
  businessUnitId?: string;
}

interface BudgetData {
  lines: TrackedLine[];
  budgetedCount: number;
  budgetAbsentYears: number[];
  windowYears: number[];
  unallocatedBudget: ByPolarity | null;
  partialBudgetCount: number;
  splitsMonth: boolean;
  bands: BudgetVarianceTracked['bands'];
}

/** A refusal by a report limiter: the route's own (with Retry-After) or withAuth's shared one (without). */
function refusal(err: unknown): { retryAfterSecs: number | null } | null {
  const e = err as { status?: unknown; retryAfterSecs?: unknown } | null;
  if (e?.status === 429) return { retryAfterSecs: typeof e.retryAfterSecs === 'number' ? e.retryAfterSecs : null };
  // Any other failure is the caller's to report (it logs it and shows BUDGET_FAILED).
  return null;
}

export function useStatementComparators(opts: StatementComparatorOptions): StatementComparators {
  const {
    trend, budget = false, asOf, basis, periodStart = '', periodEnd = '', costCentreId = '', businessUnitId = '',
  } = opts;
  const [trends, setTrends] = useState<AccountTrends | null>(null);
  const [trendFailed, setTrendFailed] = useState(false);
  const [trendLoading, setTrendLoading] = useState(false);
  const [budgetData, setBudgetData] = useState<BudgetData | null>(null);
  const [budgetFailed, setBudgetFailed] = useState(false);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [budgetLimited, setBudgetLimited] = useState<{ retryAfterSecs: number | null } | null>(null);
  const [budgetAttempt, setBudgetAttempt] = useState(0);

  useEffect(() => {
    // Clear FIRST. The cancellation flag stops an out-of-order write; it does
    // not blank what is already there, so without this the old window's
    // sparklines sit beside the new window's figures until the fetch lands.
    setTrends(null);
    setTrendFailed(false);
    if (!trend || !asOf) return;
    let cancelled = false;
    setTrendLoading(true);
    apiJson(`/api/accounting/reports-account-trends?as_of=${asOf}&basis=${basis}`, undefined, 'Could not load the trend comparison - try again')
      .then((data) => { if (!cancelled) setTrends(data); })
      .catch((err) => {
        log.warn('Failed to load account trends', { error: err }, 'useStatementComparators');
        if (!cancelled) setTrendFailed(true);
      })
      .finally(() => { if (!cancelled) setTrendLoading(false); });
    return () => { cancelled = true; };
  }, [trend, asOf, basis]);

  useEffect(() => {
    setBudgetData(null);
    setBudgetFailed(false);
    setBudgetLimited(null);
    if (!budget || !periodStart || !periodEnd) {
      setBudgetLoading(false);
      return;
    }
    let cancelled = false;
    setBudgetLoading(true);
    const q = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
    if (costCentreId) q.set('cost_centre_id', costCentreId);
    if (businessUnitId) q.set('business_unit_id', businessUnitId);
    const timer = setTimeout(() => {
      apiJson(`/api/accounting/reports-budget-comparator?${q.toString()}`, undefined, 'Could not load the budget comparison - try again')
        .then((data) => {
          if (!cancelled) {
            setBudgetData({
              lines: data.lines, budgetedCount: data.budgetedCount, budgetAbsentYears: data.budgetAbsentYears, windowYears: data.windowYears,
              unallocatedBudget: data.unallocatedBudget, partialBudgetCount: data.partialBudgetCount,
              splitsMonth: data.splitsMonth, bands: data.bands,
            });
          }
        })
        .catch((err) => {
          log.warn('Failed to load budget comparator', { error: err }, 'useStatementComparators');
          if (cancelled) return;
          const refused = refusal(err);
          if (refused) setBudgetLimited(refused);
          else setBudgetFailed(true);
        })
        .finally(() => { if (!cancelled) setBudgetLoading(false); });
    }, BUDGET_COALESCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [budget, periodStart, periodEnd, costCentreId, businessUnitId, budgetAttempt]);

  const retryBudget = useCallback(() => setBudgetAttempt((n) => n + 1), []);

  const apply = useCallback((rows: StatementRow[]): StatementRow[] => {
    let out = rows;
    if (trend && trends) out = applyTrend(out, trends);
    // No budget captured means every account's budget is zero, and applying
    // the comparator then prints a variance equal to the whole actual against
    // a target nobody set — a large red bar that is an artefact, not a
    // finding. The comparator's lines carry the engine's verdicts instead
    // (budgets P3 PR-C), so a window with no budget prints "—" on every row,
    // never a zero, and the page says why.
    if (budget && budgetData) {
      // Unspent budgets get their rows, every line its budget or "—", every band the engine's budget.
      out = applyBudgetBands(applyBudgetComparator(withBudgetedLines(out, budgetData.lines), budgetData.lines), budgetData.bands);
    }
    return out;
  }, [trend, budget, trends, budgetData]);

  const budgetState: BudgetState = !budget
    ? 'unknown'
    : budgetFailed
      ? 'failed'
      : budgetLimited
        ? 'limited'
        : budgetData === null
          ? 'unknown'
          : hasBudgetData(budgetData.budgetedCount) ? 'available' : 'none';

  const budgetInfo: BudgetInfo = {
    budgetAbsentYears: budgetData?.budgetAbsentYears ?? [],
    windowYears: budgetData?.windowYears ?? [],
    unallocatedBudget: budgetData?.unallocatedBudget ?? null,
    partialBudgetCount: budgetData?.partialBudgetCount ?? 0,
    splitsMonth: budgetData?.splitsMonth ?? false,
    retryAfterSecs: budgetLimited?.retryAfterSecs ?? null,
  };

  return {
    apply,
    budgetState,
    budgetInfo,
    retryBudget,
    trendFailed: trend && trendFailed,
    trendLoading,
    budgetLoading,
  };
}
