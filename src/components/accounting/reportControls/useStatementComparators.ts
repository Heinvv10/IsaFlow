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
 * Nothing is derived here. `applyTrend` and `applyBudgetComparator` own the
 * mapping, and they COPY figures — see `statementRows/comparators.ts`.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { AccountTrends } from '@/modules/accounting/services/reports/trendRowsService';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import {
  applyBudgetComparator, applyTrend,
} from '@/modules/accounting/services/reports/statementRows/comparators';

/** What the budget fetch has established so far. `unknown` covers both "not
 *  asked for" and "still in flight"; `failed` must never be shown as `none`. */
export type BudgetState = 'unknown' | 'failed' | 'none' | 'available';

export interface StatementComparators {
  apply: (rows: StatementRow[]) => StatementRow[];
  budgetState: BudgetState;
  trendFailed: boolean;
  trendLoading: boolean;
  budgetLoading: boolean;
}

export interface StatementComparatorOptions {
  trend: boolean;
  budget: boolean;
  /** Last day of the trend window — the statement's own period end / as-at. */
  asOf: string;
  /** `movement` for P&L accounts, `balance` for balance-sheet accounts. */
  basis: 'movement' | 'balance';
  periodStart: string;
  periodEnd: string;
}

interface BudgetData { lines: BudgetVsActualLine[]; budgetedCount: number }

export function useStatementComparators(opts: StatementComparatorOptions): StatementComparators {
  const { trend, budget, asOf, basis, periodStart, periodEnd } = opts;
  const [trends, setTrends] = useState<AccountTrends | null>(null);
  const [trendFailed, setTrendFailed] = useState(false);
  const [trendLoading, setTrendLoading] = useState(false);
  const [budgetData, setBudgetData] = useState<BudgetData | null>(null);
  const [budgetFailed, setBudgetFailed] = useState(false);
  const [budgetLoading, setBudgetLoading] = useState(false);

  useEffect(() => {
    // Clear FIRST. The cancellation flag stops an out-of-order write; it does
    // not blank what is already there, so without this the old window's
    // sparklines sit beside the new window's figures until the fetch lands.
    setTrends(null);
    setTrendFailed(false);
    if (!trend || !asOf) return;
    let cancelled = false;
    setTrendLoading(true);
    apiJson(`/api/accounting/reports-account-trends?as_of=${asOf}&basis=${basis}`)
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
    if (!budget || !periodStart || !periodEnd) return;
    let cancelled = false;
    setBudgetLoading(true);
    apiJson(`/api/accounting/reports-budget-comparator?period_start=${periodStart}&period_end=${periodEnd}`)
      .then((data) => {
        if (!cancelled) setBudgetData({ lines: data.lines, budgetedCount: data.budgetedCount });
      })
      .catch((err) => {
        log.warn('Failed to load budget comparator', { error: err }, 'useStatementComparators');
        if (!cancelled) setBudgetFailed(true);
      })
      .finally(() => { if (!cancelled) setBudgetLoading(false); });
    return () => { cancelled = true; };
  }, [budget, periodStart, periodEnd]);

  const apply = useCallback((rows: StatementRow[]): StatementRow[] => {
    let out = rows;
    if (trend && trends) out = applyTrend(out, trends);
    // No budget captured means every account's budget is zero, and applying
    // the comparator then prints a variance equal to the whole actual against
    // a target nobody set — a large red bar that is an artefact, not a
    // finding. The column stays empty and the page says why.
    if (budget && budgetData && budgetData.budgetedCount > 0) {
      out = applyBudgetComparator(out, budgetData.lines);
    }
    return out;
  }, [trend, budget, trends, budgetData]);

  const budgetState: BudgetState = !budget
    ? 'unknown'
    : budgetFailed
      ? 'failed'
      : budgetData === null
        ? 'unknown'
        : budgetData.budgetedCount > 0 ? 'available' : 'none';

  return {
    apply,
    budgetState,
    trendFailed: trend && trendFailed,
    trendLoading,
    budgetLoading,
  };
}
