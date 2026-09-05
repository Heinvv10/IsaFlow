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

/**
 * A budget "exists" when at least one account carries a non-zero budget.
 * `getBudgetVariance` returns every account it had to classify, budgeted or
 * not, so a non-empty `lines` on its own says only that the company has a
 * chart of accounts.
 */
export function hasBudget(lines: ReadonlyArray<BudgetVsActualLine>): boolean {
  return lines.some((l) => l.budget_amount !== 0);
}

export interface StatementComparators {
  apply: (rows: StatementRow[]) => StatementRow[];
  /** `null` until the budget has been fetched; `false` when none is set. */
  budgetAvailable: boolean | null;
  loading: boolean;
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

export function useStatementComparators(opts: StatementComparatorOptions): StatementComparators {
  const { trend, budget, asOf, basis, periodStart, periodEnd } = opts;
  const [trends, setTrends] = useState<AccountTrends | null>(null);
  const [lines, setLines] = useState<BudgetVsActualLine[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!trend || !asOf) return;
    let cancelled = false;
    setLoading(true);
    apiJson(`/api/accounting/reports-account-trends?as_of=${asOf}&basis=${basis}`)
      .then((data) => { if (!cancelled) setTrends(data); })
      .catch((err) => {
        // A missing trend column is a missing column, not a broken statement:
        // the figures beside it are already on screen and still correct.
        log.warn('Failed to load account trends', { error: err }, 'useStatementComparators');
        if (!cancelled) setTrends(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [trend, asOf, basis]);

  useEffect(() => {
    if (!budget || !periodStart || !periodEnd) return;
    let cancelled = false;
    setLoading(true);
    apiJson(`/api/accounting/reports-budget-comparator?period_start=${periodStart}&period_end=${periodEnd}`)
      .then((data) => { if (!cancelled) setLines(data.lines); })
      .catch((err) => {
        log.warn('Failed to load budget comparator', { error: err }, 'useStatementComparators');
        if (!cancelled) setLines(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [budget, periodStart, periodEnd]);

  const apply = useCallback((rows: StatementRow[]): StatementRow[] => {
    let out = rows;
    if (trend && trends) out = applyTrend(out, trends);
    // No budget captured means every account's budget is zero, and applying
    // the comparator then prints a variance equal to the whole actual against
    // a target nobody set — a large red bar that is an artefact, not a
    // finding. The column stays empty and the page says why.
    if (budget && lines && hasBudget(lines)) out = applyBudgetComparator(out, lines);
    return out;
  }, [trend, budget, trends, lines]);

  return { apply, budgetAvailable: lines === null ? null : hasBudget(lines), loading };
}
