/**
 * WHEN THE FIGURES OF A ROW FIT THE SHEET, AND AT WHAT SIZE THEY STILL DO.
 *
 * A KPI tile's figure and a statement table's figure cells are `white-space: nowrap` on purpose: a number split
 * across two lines is a number a reader has to reassemble. The price is that the widest figure of a column sets
 * that column's width, and past a certain scale the columns together are wider than the sheet. Content past the
 * sheet's right edge is not short, it is gone.
 *
 * This decides, exactly, off the pixel widths Chromium lays figures out at (`packFigureWidth.ts`):
 *
 *  - the row FITS at its ordinary size (22pt KPI figures, 9pt table figures): nothing is set, the markup and the
 *    stylesheet are what they always were, and the pack prints as it did;
 *  - it does not, but fits at a smaller whole-pixel size no smaller than the floor (16px / 10px, which are 12pt
 *    and 7.5pt, the pack's smallest text): the component sets that size and nothing else;
 *  - it fits at no size down to the floor: the pack is refused (`packFigureFloor.ts`), never printed cut off.
 *
 * "Fits" is the condition under which the table or grid does not overflow: the sum of the columns' MIN-CONTENT
 * widths (a figure cell never wraps, so its min-content is its width; a heading wraps to its longest word; a label
 * wraps to its longest word) plus padding and gaps is no more than the measure. It is checked against Chromium
 * at every scale in `tests/unit/print/packNothingPassesTheEdge.test.ts`.
 */
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import type { MoneyScale } from '@/lib/format/money';
import { GUTTER_MM } from './packDisclosureHeight';
import { type FigureWeight, ptToPx, textPx } from './packFigureWidth';
import type { PackTable, PackTableColumnKey, PackTableRow } from './packPageModel';
import { PAGE_WIDTH_MM, type PageOrientation } from './packTextMetrics';

export const KPI_FIGURE_MAX_PT = 22;
export const KPI_FIGURE_FLOOR_PT = 12;
export const TABLE_FIGURE_MAX_PT = 9;
export const TABLE_FIGURE_FLOOR_PT = 7.5;

const MM_PX = 96 / 25.4;
/** One pixel of slack on the measure: Chromium lays tables out in 1/64px units and rounds. */
const GUARD_PX = 0.5;
/** `.pack-table td` / `th`: 2mm either side. */
const CELL_SIDE_PX = 2 * MM_PX;
/** `.pack-table td:first-child` indents by `level x 4mm` (`INDENT_MM_PER_LEVEL`). */
const INDENT_PX_PER_LEVEL = 4 * MM_PX;
/** A footnote marker (`.pack-footnote-marker`, 0.7em, a digit) after a heading at 8pt: measured 4.64px; after a label at 9pt: 5px. */
const HEADING_MARKER_PX = 5;
const LABEL_MARKER_PX = 5;
/** A not-meaningful cell is "n/m" and a one-letter mark at 0.7em (`.pack-table-note-mark`). */
const NOT_MEANINGFUL = 'n/m a';

/**
 * The longest word of each column heading, in pixels, as `.pack-table th` sets it (8pt, uppercase, 0.06em
 * tracking: a heading wraps, so its min-content is its longest word). Measured in Chromium by
 * `packFigureWidth.test.ts`, which fails if one drifts.
 */
export const HEADING_WORD_PX: Readonly<Record<PackTableColumnKey, number>> = {
  actual: 44.9, prior: 37.3, change: 48.9, changePct: 48.9, pctOfRevenue: 55.5, budget: 47.9, variance: 59.2,
  revenue: 55.5, otherIncome: 47.9, costOfSales: 37.3, monthOperatingExpenses: 67.8, otherExpenses: 39.3, netProfit: 42.9,
};

export interface FigureFit {
  /** The whole-pixel size to set, or null where the row fits at its ordinary size and nothing is set. */
  px: number | null;
  /** False where it fits at no size down to the floor. */
  fits: boolean;
}

const measurePx = (orientation: PageOrientation): number => PAGE_WIDTH_MM[orientation] * MM_PX - GUARD_PX;

/** The weight a row is set in (`packPrintTablesAndProse.css`): subtotal 500, total and grand total 600. */
const ROW_WEIGHT: Readonly<Record<PackTableRow['role'], FigureWeight>> = { line: 400, subtotal: 500, total: 600, grandTotal: 600 };

export interface FigureCell { text: string; weight: FigureWeight }

/** What each data column of a statement table prints, cell by cell, and the weight it is set in. */
export function tableColumnCells(table: PackTable, scale: MoneyScale): FigureCell[][] {
  const columns = table.columns.filter((col) => table.rows.some((row) => row.figures[col] !== undefined));
  return columns.map((col) => table.rows.map((row) => {
    const figure = row.figures[col];
    const weight = ROW_WEIGHT[row.role];
    if (figure === undefined) return { text: '–', weight };
    return {
      text: figure.value === null ? NOT_MEANINGFUL : formatFigureText(figure, scale, col === 'changePct' ? 'change' : 'level'),
      weight,
    };
  }));
}

function cellPx(cell: FigureCell, fontPx: number): number {
  if (cell.text === NOT_MEANINGFUL) return textPx('n/m', fontPx, cell.weight) + LABEL_MARKER_PX;
  return textPx(cell.text, fontPx, cell.weight);
}

/** The narrowest a row label can be set: its longest word at 9pt (it wraps), its indent, its marker, its right padding. */
function labelMinPx(table: PackTable): number {
  const labelFontPx = Math.round(ptToPx(TABLE_FIGURE_MAX_PT));
  return Math.max(0, ...table.rows.map((row) => {
    const longest = Math.max(0, ...row.label.split(/\s+/).map((word) => textPx(word, labelFontPx, ROW_WEIGHT[row.role])));
    return row.level * INDENT_PX_PER_LEVEL + longest + (row.footnote === undefined ? 0 : LABEL_MARKER_PX) + CELL_SIDE_PX;
  }));
}

/** The total of the columns' min-content widths for a table whose figures are set at `fontPx`. */
function tableMinPx(table: PackTable, scale: MoneyScale, fontPx: number): number {
  const columns = table.columns.filter((col) => table.rows.some((row) => row.figures[col] !== undefined));
  const texts = tableColumnCells(table, scale);
  const notes = new Set((table.columnNotes ?? []).map((n) => n.column));
  const dataPx = columns.reduce((sum, col, i) => {
    const figures = Math.max(0, ...texts[i]!.map((t) => cellPx(t, fontPx)));
    const heading = HEADING_WORD_PX[col] + (notes.has(col) ? HEADING_MARKER_PX : 0);
    return sum + Math.max(figures, heading) + 2 * CELL_SIDE_PX;
  }, 0);
  return labelMinPx(table) + dataPx;
}

export function tableFit(table: PackTable, scale: MoneyScale, orientation: PageOrientation = 'portrait'): FigureFit {
  const ceiling = Math.round(ptToPx(TABLE_FIGURE_MAX_PT));
  const floor = Math.round(ptToPx(TABLE_FIGURE_FLOOR_PT));
  for (let px = ceiling; px >= floor; px -= 1) {
    if (tableMinPx(table, scale, px) <= measurePx(orientation)) return { px: px === ceiling ? null : px, fits: true };
  }
  return { px: floor, fits: false };
}

/** The width of each of a KPI row's four columns at `fontPx`: the widest figure in the column. */
export function kpiColumnFigurePx(texts: ReadonlyArray<string | null>, fontPx: number): number[] {
  const widest = [0, 0, 0, 0];
  texts.forEach((text, i) => {
    if (text !== null) widest[i % 4] = Math.max(widest[i % 4]!, textPx(text, fontPx, 500));
  });
  return widest;
}

export const KPI_GAP_PX = GUTTER_MM * MM_PX;

export function kpiFit(texts: ReadonlyArray<string | null>, orientation: PageOrientation = 'portrait'): FigureFit {
  const ceilingPx = ptToPx(KPI_FIGURE_MAX_PT);
  const floor = Math.round(ptToPx(KPI_FIGURE_FLOOR_PT));
  const total = (px: number) => kpiColumnFigurePx(texts, px).reduce((a, b) => a + b, 0) + 3 * KPI_GAP_PX;
  if (total(ceilingPx) <= measurePx(orientation)) return { px: null, fits: true };
  for (let px = Math.floor(ceilingPx); px >= floor; px -= 1) {
    if (total(px) <= measurePx(orientation)) return { px, fits: true };
  }
  return { px: floor, fits: false };
}

/** The CSS a fitted row carries; empty where the row fits at its ordinary size (the markup is then what it always was). */
export function fitAttributes(fit: FigureFit): { className?: string; style?: Record<string, string> } {
  return fit.px === null ? {} : { className: 'is-fitted', style: { '--pack-fit-size': `${fit.px}px` } };
}
