/**
 * Which comparator columns the statement shows. One control for every field
 * on `StatementColumns`, so adding a comparator to the row model surfaces
 * here rather than in five pages.
 */
import type { ComparatorKey, StatementColumns } from '@/modules/accounting/services/reports/statementRows/statementModel';

const BOX = 'h-3.5 w-3.5 accent-[var(--ff-brand-500)]';

/** Every comparator, unless a surface says otherwise. The balance sheet
 *  passes `['prior']`: a budget is a P&L figure, and a Budget checkbox there
 *  would fetch lines that match no balance-sheet account code and print an
 *  empty column, which reads as missing data rather than as "not applicable". */
const ALL: ReadonlyArray<ComparatorKey> = ['prior', 'budget'];

export interface ComparatorControlsProps {
  value: StatementColumns;
  onChange: (next: StatementColumns) => void;
  /** Comparators this surface can actually supply. Defaults to all of them. */
  comparators?: ReadonlyArray<ComparatorKey>;
  /**
   * The trend and budget columns are COMPANY-WIDE. Neither
   * `useStatementComparators` nor `getBudgetVariance` takes a cost centre, so
   * when the statement itself is filtered to one, these two are not merely
   * unhelpful — they put a company figure in the same row as a departmental
   * one. The page passes true then, and `ComparatorNotices` says why.
   */
  companyWideUnavailable?: boolean;
}

export function ComparatorControls({
  value, onChange, comparators = ALL, companyWideUnavailable = false,
}: ComparatorControlsProps) {
  const offered = (key: ComparatorKey) => comparators.includes(key);
  const anyComparator = (offered('prior') && value.prior) || (offered('budget') && value.budget);

  const set = (patch: Partial<StatementColumns>) => {
    const next = { ...value, ...patch };
    // A variance column with no comparator behind it renders four empty
    // cells per row, which reads as missing data rather than as "off".
    if (!next.prior && !next.budget) next.variance = false;
    onChange(next);
  };

  return (
    <fieldset className="flex flex-wrap items-center gap-4 text-xs text-[var(--ff-text-secondary)]">
      <legend className="sr-only">Comparison columns</legend>
      {offered('prior') && (
        <label className="inline-flex items-center gap-1.5">
          <input id="cmp-prior" type="checkbox" className={BOX} checked={value.prior}
            onChange={(e) => set({ prior: e.target.checked })} />
          <span>Prior period</span>
        </label>
      )}
      {offered('budget') && (
        <label className="inline-flex items-center gap-1.5">
          <input id="cmp-budget" type="checkbox" className={BOX} checked={value.budget}
            disabled={companyWideUnavailable}
            onChange={(e) => set({ budget: e.target.checked })} />
          <span className={companyWideUnavailable ? 'opacity-50' : ''}>Budget</span>
        </label>
      )}
      <label className="inline-flex items-center gap-1.5">
        <input id="cmp-variance" type="checkbox" className={BOX} checked={value.variance}
          disabled={!anyComparator}
          onChange={(e) => set({ variance: e.target.checked })} />
        <span className={anyComparator ? '' : 'opacity-50'}>Variance</span>
      </label>
      <label className="inline-flex items-center gap-1.5">
        <input id="cmp-trend" type="checkbox" className={BOX} checked={value.trend}
          disabled={companyWideUnavailable}
          onChange={(e) => set({ trend: e.target.checked })} />
        <span className={companyWideUnavailable ? 'opacity-50' : ''}>12-month trend</span>
      </label>
    </fieldset>
  );
}
