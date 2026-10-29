/**
 * Everything a statement page needs to run its comparator columns, in one
 * hook: the density-seeded checkbox state, the cost-centre gate on the
 * company-wide comparators, and the fetches behind them.
 *
 * It exists because the income statement and the balance sheet had assembled
 * the same four pieces themselves, in the same order, with the same rules
 * written out twice. A rule that lives in two pages is a rule that will hold
 * in one of them.
 */
import { useCallback, useMemo } from 'react';
import type {
  StatementColumns, StatementRow,
} from '@/modules/accounting/services/reports/statementRows/statementModel';
import { useComparatorColumns } from './useComparatorColumns';
import { useDensity, type Density } from './useDensity';
import { useStatementComparators, type BudgetInfo, type BudgetState } from './useStatementComparators';

export interface StatementComparatorStateOptions {
  /** The surface is filtered to one accounting dimension. */
  dimensionSelected: boolean;
  /** Last day of the trend window — the statement's period end / as-at. */
  asOf: string;
  /** `movement` for P&L accounts, `balance` for balance-sheet accounts. */
  basis: 'movement' | 'balance';
  /** The budget window. Required when the surface offers a budget. */
  periodStart?: string;
  periodEnd?: string;
  /** The statement's dimension filter ('' = none), which the budget column follows. */
  costCentreId?: string;
  businessUnitId?: string;
  /** False on a surface with no budget to offer — the balance sheet, whose
   *  account codes match no budget line. Defaults to true. */
  offersBudget?: boolean;
}

export interface StatementComparatorState {
  /** What to render and what to hand `ComparatorControls`. Already gated: a
   *  selected dimension forces the company-wide trend off. */
  columns: StatementColumns;
  setColumns: (next: StatementColumns) => void;
  /** True when a dimension is selected. Hand it to `ComparatorControls` to
   *  disable the trend checkbox and to `ComparatorNotices` to say why. */
  companyWideUnavailable: boolean;
  apply: (rows: StatementRow[]) => StatementRow[];
  budgetState: BudgetState;
  budgetInfo: BudgetInfo;
  retryBudget: () => void;
  trendFailed: boolean;
  /** The page's ONE density instance, for a `DensityToggle` if it renders one.
   *  See the module doc: a second `useDensity()` is a second preference. */
  density: Density;
  setDensity: (d: Density) => void;
  densityError: string | null;
}

export function useStatementComparatorState(
  opts: StatementComparatorStateOptions,
): StatementComparatorState {
  const {
    dimensionSelected, asOf, basis, periodStart, periodEnd, offersBudget = true, costCentreId, businessUnitId,
  } = opts;

  const densityState = useDensity();
  const { columns: chosen, setColumns: setChosen } = useComparatorColumns(densityState);

  // The trend is COMPANY-WIDE: `trendRowsService` applies no cost-centre
  // filter, so with a dimension selected it would print a company figure in
  // the same row as a departmental one. It is switched off, not fetched; the
  // reader's own choice stays in `chosen`, so clearing the filter restores it.
  // The budget follows the filter (budgets P3 PR-C), so it stays.
  const columns: StatementColumns = useMemo(
    () => (dimensionSelected ? { ...chosen, trend: false } : chosen),
    [dimensionSelected, chosen],
  );

  /**
   * `ComparatorControls` is handed the GATED columns and sends back a whole
   * `StatementColumns`, not a patch — `{ ...value, ...patch }`. Written
   * straight through, the first checkbox the reader touches under a cost
   * centre would carry the gate's own `trend: false` into `chosen`, and
   * clearing the filter would restore nothing. The field the gate forces is
   * therefore taken from `chosen` rather than from the value that was on
   * screen; every other field is the reader's actual click.
   */
  const setColumns = useCallback((next: StatementColumns) => {
    setChosen(dimensionSelected ? { ...next, trend: chosen.trend } : next);
  }, [dimensionSelected, chosen.trend, setChosen]);

  const { apply, budgetState, budgetInfo, retryBudget, trendFailed } = useStatementComparators({
    trend: columns.trend,
    budget: offersBudget && columns.budget,
    asOf,
    basis,
    periodStart,
    periodEnd,
    costCentreId,
    businessUnitId,
  });

  return {
    columns,
    setColumns,
    companyWideUnavailable: dimensionSelected,
    apply,
    budgetState,
    budgetInfo,
    retryBudget,
    trendFailed,
    density: densityState.density,
    setDensity: densityState.setDensity,
    densityError: densityState.error,
  };
}
