/**
 * The three-way grids' renderer (budgets P6 spec §8): sections × columns (opening, months, FY), styled as the
 * statements' `StatementGrid` (same tokens, `formatStatementFigure`, brackets for negatives). `StatementGrid`
 * itself is an Actual-plus-comparators layout and cannot take a column per month, hence this one. It adds
 * nothing up: rows come from `threeWayRows`. Only the table scrolls sideways (the page never does, 390 px); the
 * label column stays pinned. Figures are cents on the wire, shown in whole rands.
 */
import { formatStatementFigure } from '@/lib/format/money';
import type { GridModel, GridRow } from './threeWayRows';

const ROW_CLS: Record<GridRow['kind'], string> = {
  section: 'text-xs font-semibold uppercase tracking-wide text-[var(--ff-text-tertiary)]',
  line: 'text-[var(--ff-text-primary)]',
  subtotal: 'font-medium text-[var(--ff-text-primary)] border-t border-[var(--ff-border-light)]',
  total: 'font-semibold text-[var(--ff-text-primary)] border-t-2 border-[var(--ff-border-secondary)]',
  check: 'text-xs text-[var(--ff-text-secondary)] border-t border-[var(--ff-border-light)]',
};

export interface ThreeWayGridProps {
  model: GridModel;
  title: string;
  testId: string;
}

export function ThreeWayGrid({ model, title, testId }: ThreeWayGridProps) {
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]" data-testid={`${testId}-scroll`}>
      <table className="w-full border-collapse text-sm" data-testid={testId} data-density-exempt>
        <thead>
          <tr className="border-b border-[var(--ff-border-secondary)] text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)]">
            <th scope="col" className="sticky left-0 z-10 bg-[var(--ff-bg-secondary)] py-2 pl-3 pr-2 text-left font-medium">{title}</th>
            {model.columns.map((c) => <th key={c} scope="col" className="whitespace-nowrap py-2 pl-2 pr-3 text-right font-medium">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((r) => (
            <tr key={r.key} data-row={r.key} data-kind={r.kind} className={ROW_CLS[r.kind]}>
              <th scope="row" className={`sticky left-0 z-10 bg-[var(--ff-bg-secondary)] py-1.5 pl-3 pr-2 text-left font-[inherit] ${r.kind === 'line' ? 'pl-5' : ''}`}>
                <span className="block min-w-[10rem] max-w-[16rem]">{r.label}</span>
              </th>
              {r.values.map((v, i) => (
                <td key={model.columns[i]} className="whitespace-nowrap py-1.5 pl-2 pr-3 text-right tabular-nums"
                  data-col={model.columns[i]} data-cents={v ?? undefined}>
                  {v === null ? '' : r.kind === 'check' && v === 0 ? '0' : formatStatementFigure(v / 100, { cents: r.kind === 'check' })}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
