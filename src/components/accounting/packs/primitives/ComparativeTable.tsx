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
import { collectReasons, NotMeaningfulCell, NotMeaningfulNotes } from './notMeaningfulNotes';
import type { MoneyScale } from '@/lib/format/money';
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

/** Spec §5.5: zebra banding applies only once a table EXCEEDS this many
 *  rows — a table at exactly the threshold does not band. */
const ZEBRA_ROW_THRESHOLD = 12;

export interface ComparativeTableProps {
  table: PackTable;
  /** The document's `numberConvention.scale`. Required: this table prints
   *  `table.scale` as its caption, so cells formatted at any other scale
   *  contradict the header above them by a factor of a thousand. */
  scale: MoneyScale;
}

export function ComparativeTable({ table, scale }: ComparativeTableProps) {
  const columns = table.columns.filter((col) =>
    table.rows.some((row) => row.figures[col] !== undefined),
  );
  const isLong = table.rows.length > ZEBRA_ROW_THRESHOLD;
  const notes = collectReasons(table.rows.flatMap((row) => columns.map((col) => row.figures[col])));

  /** A cell: the figure, or the mark that points at its not-meaningful note. */
  const cell = (figure: PackTableRow['figures'][PackTableColumnKey]) => {
    if (figure === undefined) return '–';
    if (figure.value !== null) return formatFigureText(figure, scale);
    return <NotMeaningfulCell figure={figure} reasons={notes} />;
  };

  return (
    <>
    <table className={isLong ? 'pack-table is-long' : 'pack-table'}>
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
            {columns.map((col) => (
              <td key={col}>{cell(row.figures[col])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    <NotMeaningfulNotes reasons={notes} />
    </>
  );
}
