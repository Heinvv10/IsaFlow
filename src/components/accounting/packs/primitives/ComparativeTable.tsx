/**
 * A comparative statement table — actual vs prior (vs budget, vs variance),
 * one row per line item, with subtotal/total/grand-total rules from the
 * row's `role`.
 *
 * Columns are DATA-driven, not `table.columns`-driven: a column with no
 * figure on any row is dropped entirely rather than printed as a column of
 * dashes — an absent comparative is an absent column, not one that never
 * had anything to say. `table.columns` still fixes the ORDER columns print
 * in when they are present.
 */
import { formatFigureText } from './packFigureText';
import type {
  PackTable,
  PackTableColumnKey,
  PackTableRow,
} from '@/modules/accounting/services/packs/pages/packPageModel';

const COLUMN_LABEL: Record<PackTableColumnKey, string> = {
  actual: 'Actual',
  prior: 'Prior',
  change: 'Change',
  changePct: 'Change %',
  pctOfRevenue: '% of Revenue',
  budget: 'Budget',
  variance: 'Variance',
};

const ROW_ROLE_CLASS: Record<PackTableRow['role'], string | undefined> = {
  line: undefined,
  subtotal: 'is-subtotal',
  total: 'is-total',
  grandTotal: 'is-grand-total',
};

/** Per indent level, matching `PackTableRow.level`'s 0-2 range. */
const INDENT_MM_PER_LEVEL = 4;

export interface ComparativeTableProps {
  table: PackTable;
}

export function ComparativeTable({ table }: ComparativeTableProps) {
  const columns = table.columns.filter((col) =>
    table.rows.some((row) => row.figures[col] !== undefined),
  );

  return (
    <table className="pack-table">
      <caption>{table.scale}</caption>
      <thead>
        <tr>
          <th />
          {columns.map((col) => (
            <th key={col}>{COLUMN_LABEL[col]}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, index) => (
          <tr key={`${row.label}-${index}`} className={ROW_ROLE_CLASS[row.role]}>
            <td style={{ paddingLeft: `${row.level * INDENT_MM_PER_LEVEL}mm` }}>{row.label}</td>
            {columns.map((col) => {
              const figure = row.figures[col];
              return <td key={col}>{figure ? formatFigureText(figure) : '–'}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
