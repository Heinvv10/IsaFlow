/**
 * HOW A ROW OF NOWRAP FIGURES TELLS THE PRINT STYLESHEET HOW WIDE IT IS.
 *
 * A KPI tile's figure and a statement table's figure cells are `white-space: nowrap` on purpose: a
 * number split across two lines is a number a reader has to reassemble. The price is that the widest
 * figure of a column sets that column's width, and at a large enough scale the columns together are
 * wider than the sheet. Content past the sheet's right edge is not short, it is gone: page 3's tile
 * row did it from a net profit of (13 350 000) (R'000), page 6's eight-column table at (297 000 000).
 *
 * So the figures shrink to fit instead, and only then. The component states, as a custom property, the
 * summed widths of the widest figure of each column in ems of the pack's own ruler (`textWidthEms`);
 * the stylesheet divides the room the row has by that and takes the smaller of the result and the
 * size the figure normally has. Where the figures fit at their normal size the result is the normal
 * size and the page prints exactly as it did. No figure, label or unit changes.
 */
import type { CSSProperties } from 'react';
import { formatFigureText } from './packFigureText';
import type { MoneyScale } from '@/lib/format/money';
import type { PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';
import { textWidthEms } from '@/modules/accounting/services/packs/pages/packTextMetrics';

/** A style object carrying CSS custom properties, which React's `CSSProperties` does not name. */
export type FitStyle = CSSProperties & Record<`--${string}`, string | number>;

/**
 * THE WIDTH OF A PRINTED FIGURE, IN EMS OF ITS OWN FONT SIZE.
 *
 * The pack's general text ruler (`textWidthEms`) is for proportional prose and is wrong for figures in
 * both directions: measured in Chromium over 2,000 printed figures it over-reads long digit strings by up
 * to 16% (figures are set in tabular numerals, 0.59em a digit in a table and a little more at 22pt in a heavier weight, and a thousands separator is a narrow
 * no-break space) and UNDER-reads percentages by up to 19%. Both matter here: over-reading shrinks figures
 * that would have fitted, under-reading lets a column run past the sheet. So figures are measured off
 * the widths Chromium laid them out at (`packNothingPassesTheEdge.test.ts` holds this table to the printed
 * sheet, never short and within 20%), with 10% headroom (text set at a shrunk, fractional font size lays out up to 9% wider per em than at a whole size); a character this table does not know falls back
 * to the general ruler plus 15% (words in a figure cell: "days", "n/m", "×" sit in a heavier face).
 */
const DIGITS = '0123456789';
const widths = (digit: number, six: number, rest: Record<string, number>): Readonly<Record<string, number>> =>
  ({ ...Object.fromEntries([...DIGITS].map((d) => [d, d === '6' ? six : digit])), ...rest });
/** 9pt (a statement table's cells), regular weight. */
const TABLE_FIGURE_EM = widths(0.6, 0.62, {
  '\u00a0': 0.29, '(': 0.36, ')': 0.36, '+': 0.6, '.': 0.6, '%': 0.7, '\u2013': 0.6, '\u2212': 0.6, '-': 0.6, '/': 0.66,
});
/** 22pt, weight 500 (a KPI tile's figure). */
const KPI_FIGURE_EM = widths(0.64, 0.66, {
  '\u00a0': 0.32, '(': 0.38, ')': 0.38, '+': 0.6, '.': 0.6, '%': 0.8, '\u00d7': 0.45, '\u2013': 0.6, '\u2212': 0.6, '-': 0.6, '/': 0.66,
});
const FIGURE_HEADROOM = 1.1;

export type FigureKind = 'table' | 'kpi';
/** A printed figure's text. (Semibold total rows lay out at the regular advance: measured, not assumed.) */
export type FigureCell = string;

export function figureTextEms(text: string, kind: FigureKind = 'table'): number {
  const em = kind === 'kpi' ? KPI_FIGURE_EM : TABLE_FIGURE_EM;
  let ems = 0;
  for (const ch of text) ems += em[ch] ?? textWidthEms(ch) * 1.15;
  return ems * FIGURE_HEADROOM;
}

/** The summed widths, in ems, of the widest text in each column. */
export function widestPerColumnEms(columns: ReadonlyArray<ReadonlyArray<FigureCell>>, kind: FigureKind = 'table'): number {
  return columns.reduce(
    (sum, texts) => sum + texts.reduce((widest, text) => Math.max(widest, figureTextEms(text, kind)), 0),
    0,
  );
}

/** A KPI tile row: tile `i` sits in column `i % columns`. */
export function kpiFitStyle(texts: ReadonlyArray<string | null>, columns = 4): FitStyle {
  const byColumn: string[][] = Array.from({ length: columns }, () => []);
  texts.forEach((text, i) => { if (text !== null) byColumn[i % columns]!.push(text); });
  return { '--pack-fit-ems': Number(widestPerColumnEms(byColumn, 'kpi').toFixed(2)) };
}

/**
 * THE LABEL COLUMN AND THE CELL PADDING A STATEMENT TABLE'S FIGURES SHARE THE BOX WITH.
 *
 * Hard-coded in `styles/packPrintTablesAndProse.css` (`.pack-table-box .pack-table td`, "30mm" and "4mm"):
 * 30mm is the narrowest label column the pack leaves ("Operating expenses" wraps to two lines in it, the
 * tallest the height model charges), 4mm is `.pack-table td`'s 2mm either side. Change one and change the
 * other; `packFigureFloor.ts` reads these to say whether a table's figures can be set at all.
 */
export const TABLE_LABEL_COLUMN_MM = 30;
export const TABLE_CELL_PADDING_MM = 4;

/** What each data column of a statement table prints, cell by cell: the figure's own text, '–' for an
 *  absent cell and the n/m mark for a cell with no value. The component and the readability gate read this. */
export function tableColumnTexts(
  table: PackTable,
  scale: MoneyScale,
): string[][] {
  const columns = table.columns.filter((col) => table.rows.some((row) => row.figures[col] !== undefined));
  return columns.map((col) => table.rows.map((row) => {
    const figure = row.figures[col];
    if (figure === undefined) return '–';
    return figure.value === null ? 'n/m a' : formatFigureText(figure, scale, col === 'changePct' ? 'change' : 'level');
  }));
}

/** A statement table: one list of printed cell texts per data column. */
export function tableFitStyle(columnTexts: ReadonlyArray<ReadonlyArray<FigureCell>>): FitStyle {
  return {
    '--pack-fit-ems': Number(widestPerColumnEms(columnTexts).toFixed(2)),
    '--pack-fit-cols': columnTexts.length,
  };
}
