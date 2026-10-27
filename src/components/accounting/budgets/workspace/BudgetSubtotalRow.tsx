/**
 * The grid's read-only rows (spec §6.2): a band's section head, its "Total <band>" row and the
 * GP / OP / NP rows, plus the figure helpers every grid row shares. The figures come from the
 * store (`subtotals.ts` folds them); this file only prints them.
 *
 * KIND_CLASS / FIG_STYLE are StatementRowView's values, copied (StatementRowView renders a
 * `StatementRow`, which has no months).
 */
import { memo, type CSSProperties, type ReactNode } from 'react';
import { formatPct, formatStatementFigure } from '@/lib/format/money';
import { varianceColor } from '@/components/accounting/charts/ibcs';
import type { ChartPalette } from '@/components/accounting/charts/chartTypes';
import { STICKY_FIRST_CELL } from '@/components/accounting/statement/stickyTable';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { Metric } from '@/modules/accounting/services/budgets/grid/subtotals';
import { rowVariance } from '@/modules/accounting/services/budgets/grid/variance';
import type { GridStore } from './gridStore';
import { useGridTotal } from './gridStoreHooks';
import type { LayoutRow } from './types';

export const KIND_CLASS = {
  section: 'text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)]',
  line: 'text-[var(--ff-text-secondary)]',
  subtotal: 'font-semibold border-t border-[var(--ff-text-primary)]',
  total: 'font-semibold border-t border-[var(--ff-text-primary)]',
  grand: 'font-bold border-t border-[var(--ff-text-primary)] [border-bottom:3px_double_var(--ff-text-primary)]',
} as const;

export const FIG_STYLE: CSSProperties = { fontFamily: 'var(--ff-fig-font, inherit)' };
export const FIG = 'text-right whitespace-nowrap tabular-nums';

/** Which optional columns show (density, toolbar toggles, a picked compare version, phone width). */
export interface GridColumns {
  py: boolean;
  delta: boolean;
  deltaPct: boolean;
  trend: boolean;
  compare: boolean;
  /** Accountant density prints cents. */
  cents: boolean;
}

/** Not budgeted (null) prints nothing; a budgeted zero prints the en dash. */
export function fig(cents: number | null, withCents: boolean): string {
  return cents === null ? '' : formatStatementFigure(cents / 100, { cents: withCents });
}

/** Spoken figure for an aria-label: "R 1 234" / "not budgeted". */
export function spoken(cents: number | null): string {
  return cents === null ? 'not budgeted' : `R ${formatStatementFigure(cents / 100, { cents: true })}`;
}

const INCOME_METRICS: ReadonlySet<Metric> = new Set<Metric>(['turnover', 'grossProfit', 'otherIncome', 'operatingProfit', 'netProfit']);
export const metricIsIncome = (m: Metric): boolean => INCOME_METRICS.has(m);

/**
 * PY, Δ vs PY (R and %), the PY trend slot and Δ vs compare, in column order (spec §6.1). `incomeUp`: revenue up is favourable,
 * expense up is unfavourable. A PY of zero gives "—", never a percentage of zero. The figures come
 * from PR-A `rowVariance`; this only prints them.
 */
export function DeltaCells({ fy, pyFy, compareFy, cols, incomeUp, palette, trend }: {
  fy: number | null; pyFy: number | null; compareFy: number | null;
  cols: GridColumns; incomeUp: boolean; palette: ChartPalette; trend?: ReactNode;
}) {
  const v = rowVariance(fy, pyFy, compareFy, incomeUp);
  const pyColour = varianceColor(v.favPy, palette);
  const cmpColour = varianceColor(v.favCmp, palette);
  const cell = `${FIG} px-2 py-1 text-xs`;
  return (
    <>
      {cols.py && (
        <td role="gridcell" aria-readonly="true" className={`${FIG} px-2 py-1 text-[var(--ff-text-tertiary)]`} style={FIG_STYLE}>
          {fig(pyFy, cols.cents)}
        </td>
      )}
      {cols.delta && (
        <td role="gridcell" aria-readonly="true" className={cell} style={{ ...FIG_STYLE, color: pyColour }}>
          {fig(v.dPy, cols.cents)}
        </td>
      )}
      {cols.deltaPct && (
        <td role="gridcell" aria-readonly="true" className={cell} style={{ ...FIG_STYLE, color: pyColour }}>
          {v.pyZero ? '—' : v.pct === null ? '' : formatPct(v.pct)}
        </td>
      )}
      {cols.trend && <td role="gridcell" aria-readonly="true" className="px-2 text-[var(--ff-text-secondary)]">{trend}</td>}
      {cols.compare && (
        <td role="gridcell" aria-readonly="true" className={cell} style={{ ...FIG_STYLE, color: cmpColour }}>
          {fig(v.dCmp, cols.cents)}
        </td>
      )}
    </>
  );
}

interface TotalRowProps {
  store: GridStore;
  row: Extract<LayoutRow, { kind: 'subtotal' | 'total' | 'grand' }>;
  months: readonly string[];
  cols: GridColumns;
  palette: ChartPalette;
}

/** A band total or a GP / OP / NP row: live per month and FY, never focusable. `aria-readonly` sits on each cell (a <tr> may not carry it). */
export const BudgetSubtotalRow = memo(function BudgetSubtotalRow({ store, row, months, cols, palette }: TotalRowProps) {
  const t = useGridTotal(store, row.metric);
  return (
    <tr data-kind={row.kind} aria-rowindex={row.index + 2} className={`${KIND_CLASS[row.kind]} text-sm`}>
      <th role="rowheader" scope="row" className={`text-left px-3 py-1.5 ${STICKY_FIRST_CELL}`}>{row.label}</th>
      {months.map((m, i) => {
        const v = t.months[i] ?? 0;
        return (
          <td key={m} role="gridcell" aria-readonly="true" aria-label={`${row.label}, ${monthLabel(m)}, ${spoken(v)}`}
            className={`${FIG} px-2 py-1.5`} style={FIG_STYLE}>
            {fig(v, cols.cents)}
          </td>
        );
      })}
      <td role="gridcell" aria-readonly="true" aria-label={`${row.label}, full year, ${spoken(t.fy)}`} className={`${FIG} px-2 py-1.5`} style={FIG_STYLE}>
        {fig(t.fy, cols.cents)}
      </td>
      <DeltaCells fy={t.fy} pyFy={t.pyFy} compareFy={t.compareFy} cols={cols} incomeUp={metricIsIncome(row.metric)} palette={palette} />
      <td role="gridcell" aria-readonly="true" />
    </tr>
  );
});

/** A band's section head: label only; navigation skips it. */
export function BudgetSectionRow({ row, colCount }: { row: Extract<LayoutRow, { kind: 'section' }>; colCount: number }) {
  return (
    <tr data-kind="section" aria-rowindex={row.index + 2} className={KIND_CLASS.section}>
      <th role="rowheader" scope="row" className={`text-left px-3 pt-4 pb-1 ${STICKY_FIRST_CELL}`}>{row.label}</th>
      <td role="gridcell" aria-readonly="true" colSpan={colCount - 1} />
    </tr>
  );
}
