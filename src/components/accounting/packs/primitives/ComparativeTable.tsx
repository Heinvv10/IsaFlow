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
import { FootnoteMarker } from './FootnoteMarker';
import type { MoneyScale } from '@/lib/format/money';
import { PACK_TABLE_COLUMN_LABEL } from '@/modules/accounting/services/packs/pages/packBlockModel';
import type {
  PackTable,
  PackTableColumnKey,
  PackTableRow,
} from '@/modules/accounting/services/packs/pages/packPageModel';

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
  // THE NUMBERED FOOTNOTES GET THEIR SUPERSCRIPTS HERE, and until now this
  // table drew none — the pack's whole numbered series pointed at nothing on
  // pages 5 to 8. Same primitive `ScorecardTable` has always used for the
  // same purpose, so the two tables mark a footnote identically.
  const columnNote = (col: PackTableColumnKey): number | null =>
    table.columnNotes?.find((n) => n.column === col)?.footnote ?? null;
  const notes = collectReasons(table.rows.flatMap((row) => columns.map((col) => row.figures[col])));

  /**
   * A cell: the figure, or the mark that points at its not-meaningful note.
   *
   * A DASH IS A NIL, AND A ROW WITH NO VALUE HAS NO NILS IN IT. `formatMoney`
   * prints a measured zero as an en dash, so the same glyph meant two
   * incompatible things one page apart: on the income statement "Other
   * expenses – – –" is a genuine zero, and on the cash page the same dash
   * filled the prior, change and change-% cells of three rows whose ACTUAL is
   * n/m because nothing was captured. A director adding that column read "no
   * movement" for three measures that have no value at all.
   *
   * So a derived cell of a row whose actual is not meaningful prints `n/m`,
   * carrying the actual's own mark to the actual's own reason: nothing was
   * measured, so nothing derived from it can be.
   */
  const cell = (row: PackTableRow, col: PackTableColumnKey) => {
    const figure = row.figures[col];
    if (figure !== undefined) {
      if (figure.value !== null) return formatFigureText(figure, scale);
      return <NotMeaningfulCell figure={figure} reasons={notes} />;
    }
    const actual = row.figures.actual;
    if (col !== 'actual' && actual !== undefined && actual.value === null) {
      return <NotMeaningfulCell figure={actual} reasons={notes} />;
    }
    return '–';
  };

  return (
    <>
    <table className={isLong ? 'pack-table is-long' : 'pack-table'}>
      <caption>{table.scale}</caption>
      <thead>
        <tr>
          <th />
          {columns.map((col) => (
            <th key={col}>
              {PACK_TABLE_COLUMN_LABEL[col]}
              <FootnoteMarker number={columnNote(col)} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, index) => (
          <tr key={`${row.label}-${index}`} className={ROW_ROLE_CLASS[row.role]}>
            <td style={{ paddingLeft: `${row.level * INDENT_MM_PER_LEVEL}mm` }}>
              {row.label}
              <FootnoteMarker number={row.footnote ?? null} />
            </td>
            {columns.map((col) => (
              <td key={col}>{cell(row, col)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    <NotMeaningfulNotes reasons={notes} />
    </>
  );
}
