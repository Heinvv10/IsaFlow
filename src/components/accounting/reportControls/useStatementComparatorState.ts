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
import { useStatementComparators, type BudgetState } from './useStatementComparators';

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
  /** False on a surface with no budget to offer — the balance sheet, whose
   *  account codes match no budget line. Defaults to true. */
  offersBudget?: boolean;
}

export interface StatementComparatorState {
  /** What to render and what to hand `ComparatorControls`. Already gated: a
   *  selected cost centre forces the two company-wide columns off. */
  columns: StatementColumns;
  setColumns: (next: StatementColumns) => void;
  /** True when a cost centre is selected. Hand it to `ComparatorControls` to
   *  disable the two checkboxes and to `ComparatorNotices` to say why. */
  companyWideUnavailable: boolean;
  apply: (rows: StatementRow[]) => StatementRow[];
  budgetState: BudgetState;
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
    dimensionSelected, asOf, basis, periodStart, periodEnd, offersBudget = true,
  } = opts;

  const densityState = useDensity();
  const { columns: chosen, setColumns: setChosen } = useComparatorColumns(densityState);

  // The trend and the budget are COMPANY-WIDE: `trendRowsService` applies no
  // cost-centre filter and `getBudgetVariance` takes no cost centre. With one
  // selected, those two columns would print a company figure in the same row
  // as a departmental one. They are switched off, not fetched. The reader's
  // own choice stays in `chosen`, so clearing the filter restores it.
  const columns: StatementColumns = useMemo(
    () => (dimensionSelected
      ? { ...chosen, budget: false, trend: false, variance: chosen.variance && chosen.prior }
      : chosen),
    [dimensionSelected, chosen],
  );

  /**
   * `ComparatorControls` is handed the GATED columns and sends back a whole
   * `StatementColumns`, not a patch — `{ ...value, ...patch }`. Written
   * straight through, the first checkbox the reader touches under a cost
   * centre would carry the gate's own `budget: false, trend: false` into
   * `chosen`, and clearing the filter would restore nothing. The two fields
   * the gate forces are therefore taken from `chosen` rather than from the
   * value that was on screen; every other field is the reader's actual click.
   */
  const setColumns = useCallback((next: StatementColumns) => {
    setChosen(dimensionSelected
      ? { ...next, budget: chosen.budget, trend: chosen.trend }
      : next);
  }, [dimensionSelected, chosen.budget, chosen.trend, setChosen]);

  const { apply, budgetState, trendFailed } = useStatementComparators({
    trend: columns.trend,
    budget: offersBudget && columns.budget,
    asOf,
    basis,
    periodStart,
    periodEnd,
  });

  return {
    columns,
    setColumns,
    companyWideUnavailable: dimensionSelected,
    apply,
    budgetState,
    trendFailed,
    density: densityState.density,
    setDensity: densityState.setDensity,
    densityError: densityState.error,
  };
}
