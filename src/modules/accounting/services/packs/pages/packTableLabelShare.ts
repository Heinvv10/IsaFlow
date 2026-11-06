/**
 * How much of a statement table's width its label column gets, as the print layout will give it
 * (budgets P3 PR-E review). `.pack-table` figure cells never wrap (`white-space: nowrap`) and the
 * label column does, so a table whose figures are wide leaves the label less room and its labels
 * wrap: page 6 with eight data columns and figures in the billions printed "Operating / expenses"
 * on two lines, ran taller than the fit model said, and spilled onto a thirteenth sheet. The model
 * charged every table a fixed 40% label column; it now charges the room the figures actually leave,
 * never more than that 40%, so a table that had room is measured exactly as before.
 */
import { formatPct, formatStatementFigure, type MoneyScale } from '@/lib/format/money';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { PACK_TABLE_COLUMN_LABEL, type PackTable } from './packTableModel';
import { PT_MM, textWidthEms } from './packTextMetrics';

/** What every statement table was budgeted at before; still the ceiling. */
export const DEFAULT_LABEL_SHARE = 0.4;
/** `.pack-table td` / `th`: 2mm either side. */
const CELL_PADDING_MM = 4;
const FIGURE_PT = 9;
const HEAD_PT = 8;
/** `.pack-table th`: uppercase at letter-spacing 0.06em. */
const HEAD_TRACKING = 1.06;
/** The floor: a label column never measured narrower than this share (one short word). */
const MIN_LABEL_SHARE = 0.1;

/** The cell's text as the table prints it, closely enough to measure: n/m plus its mark for a null. */
function cellText(figure: PackFigure, scale: MoneyScale): string {
  if (figure.value === null) return 'n/m a';
  if (figure.format === 'pct') return formatPct(figure.value, 1, { pack: true });
  if (figure.format === 'money') return formatStatementFigure(figure.value, { scale, pack: true });
  return String(figure.value);
}

export function tableLabelShare(table: PackTable, widthMm: number, scale: MoneyScale): number {
  const columnsMm = table.columns.reduce((sum, col) => {
    // A heading may wrap (`th` is not nowrap), so it holds the column only as wide as its longest word.
    const head = Math.max(...PACK_TABLE_COLUMN_LABEL[col].toUpperCase().split(' ').map(textWidthEms)) * HEAD_PT * HEAD_TRACKING;
    const cells = table.rows
      .map((row) => row.figures[col])
      .filter((f): f is PackFigure => f !== undefined)
      .map((f) => textWidthEms(cellText(f, scale)) * FIGURE_PT);
    return sum + Math.max(head, ...cells) * PT_MM + CELL_PADDING_MM;
  }, 0);
  return Math.min(DEFAULT_LABEL_SHARE, Math.max(MIN_LABEL_SHARE, (widthMm - columnsMm) / widthMm));
}
