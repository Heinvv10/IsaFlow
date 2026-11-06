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
import { collectReasons, noteMark } from '@/components/accounting/packs/primitives/notMeaningfulNotes';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { MoneyScale } from '@/lib/format/money';
import { GUTTER_MM } from './packDisclosureHeight';
import { type FigureWeight, ptToPx, textPx, textPxUnsnapped } from './packFigureWidth';
import { reasonPx } from './packReasonWidth';
import { deltaWithWord } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import { deltaDirection } from '@/modules/accounting/services/packs/narrative/derivedTileCaptions';
import type { PackPageBlock, PackTable, PackTableColumnKey, PackTableRow } from './packPageModel';
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
/** A not-meaningful cell is "n/m" and the mark of its note (`.pack-table-note-mark`). */
const NOT_MEANINGFUL = 'n/m';

/**
 * A FOOTNOTE MARK, MEASURED AT THE SIZE IT IS SET AT. `.pack-footnote-marker` and `.pack-table-note-mark` are 0.7em
 * superscripts, and Chromium rounds that size to a whole pixel and each glyph's advance after it: after a 9pt (12px)
 * label a digit is 5px and two digits 10px; "m" is 7px, "w" 6px, "aa" 8px, "mw" 13px; at a 10px figure a digit is
 * 4px. (A flat 5px was 5px short from the 10th note and 1px over at the floor.) `packFigureWidth.test.ts` re-measures
 * them.
 */
const markPx = (text: string, hostPx: number, weight: FigureWeight): number => textPxUnsnapped(text, 0.7 * hostPx, weight);
/** A row's or KPI tile's footnote number after its 9pt label. */
export const labelMarkPx = (number: number | null | undefined, weight: FigureWeight = 400): number => (number === null || number === undefined ? 0 : markPx(String(number), 12, weight));
/** A heading's footnote number: the 8pt heading's 7px digits (4px) plus its 0.06em letter-spacing (0.64px) each. */
export const headingMarkPx = (number: number | undefined): number => (number === undefined ? 0 : String(number).length * 4.65);

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

export interface FigureCell { text: string; weight: FigureWeight; /** A not-meaningful cell's mark: "a", "b", ... "aa". */ mark?: string }

/** What each data column of a statement table prints, cell by cell, and the weight it is set in. */
export function tableColumnCells(table: PackTable, scale: MoneyScale): FigureCell[][] {
  const columns = table.columns.filter((col) => table.rows.some((row) => row.figures[col] !== undefined));
  // The marks are the table's own, in the order its reasons are first met (as `ComparativeTable` numbers them).
  const reasons = collectReasons(table.rows.flatMap((row) => columns.map((col) => row.figures[col])));
  const markOf = (figure: PackFigure): string => {
    const at = figure.unavailable ? reasons.indexOf(figure.unavailable) : -1;
    return at >= 0 ? noteMark(at) : '';
  };
  return columns.map((col) => table.rows.map((row) => {
    const figure = row.figures[col];
    const weight = ROW_WEIGHT[row.role];
    if (figure === undefined) {
      // The table prints "n/m" (and its mark) in a derived cell of a row whose actual is not meaningful, not the dash.
      const actual = row.figures.actual;
      const notMeaningful = col !== 'actual' && actual !== undefined && actual.value === null;
      return notMeaningful ? { text: NOT_MEANINGFUL, weight, mark: markOf(actual) } : { text: '–', weight };
    }
    if (figure.value === null) return { text: NOT_MEANINGFUL, weight, mark: markOf(figure) };
    return { text: formatFigureText(figure, scale, col === 'changePct' ? 'change' : 'level'), weight };
  }));
}

export function cellPx(cell: FigureCell, fontPx: number): number {
  return textPx(cell.text, fontPx, cell.weight) + (cell.mark === undefined ? 0 : markPx(cell.mark, fontPx, cell.weight));
}

/** The narrowest a row label can be set: its longest word at 9pt (it wraps), its indent, its marker, its right padding. */
function labelMinPx(table: PackTable): number {
  const labelFontPx = Math.round(ptToPx(TABLE_FIGURE_MAX_PT));
  return Math.max(0, ...table.rows.map((row) => {
    const longest = Math.max(0, ...row.label.split(/\s+/).map((word) => textPx(word, labelFontPx, ROW_WEIGHT[row.role])));
    return row.level * INDENT_PX_PER_LEVEL + longest + labelMarkPx(row.footnote, ROW_WEIGHT[row.role]) + CELL_SIDE_PX;
  }));
}

/** The total of the columns' min-content widths for a table whose figures are set at `fontPx`. */
function tableMinPx(table: PackTable, scale: MoneyScale, fontPx: number): number {
  const columns = table.columns.filter((col) => table.rows.some((row) => row.figures[col] !== undefined));
  const texts = tableColumnCells(table, scale);
  const dataPx = columns.reduce((sum, col, i) => {
    const figures = Math.max(0, ...texts[i]!.map((t) => cellPx(t, fontPx)));
    const heading = HEADING_WORD_PX[col] + headingMarkPx(table.columnNotes?.find((n) => n.column === col)?.footnote);
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

export type KpiTile = (PackPageBlock & { kind: 'kpiTiles' })['tiles'][number];

/** The words a KPI tile's delta line prints (the same call the tile makes): "up 12.0% prior period". */
export function deltaText(tile: KpiTile): string {
  const delta = tile.delta;
  if (delta === null) return '';
  const direction = deltaDirection(delta);
  return `${deltaWithWord(delta, direction, direction, 'pp', 'flat on')} ${delta.basis}`;
}

/** The runs of `text` a line may break between: at spaces, and after a hyphen. */
function runsOf(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== '').flatMap((word) => word.split(/(?<=-)/));
}

/** The longest unbreakable run of `text`. */
function longestRunPx(text: string, fontPx: number, weight: FigureWeight): number {
  return Math.max(0, ...runsOf(text).map((run) => textPx(run, fontPx, weight)));
}

/**
 * The narrowest a tile can be set apart from its figure: its label's longest run at 9pt (with its footnote marker),
 * its not-meaningful reason's at 11pt (italic: its own advances, `packReasonWidth.ts`) and its delta line's at 9pt after
 * the 7pt arrow. A `1fr` grid column is never narrower than any of them, so a short figure under a long word still
 * holds its column open (the adversary's net-debit Debt-to-equity tile: 50px of figure under a 56px label).
 */
function tileOtherMinPx(tile: KpiTile): number {
  const labelPx = longestRunPx(tile.label, 12, 400) + (labelMarkPx(tile.trendFootnote));
  const reasonWidth = tile.figure.value === null && tile.figure.unavailable !== undefined && tile.figure.unavailable !== null
    ? Math.max(0, ...runsOf(tile.figure.unavailable).map(reasonPx)) : 0;
  // The arrow cue is a run of its own (`</span>{' '}` after it is a break opportunity): it never holds a column open
  // past the words it precedes.
  const deltaPx = tile.delta === null ? 0 : Math.max(DELTA_CUE_PX, longestRunPx(deltaText(tile), 12, 400));
  return Math.max(labelPx, reasonWidth, deltaPx);
}
/** The arrow cue before a delta, a 7pt glyph: 7px ("↑" alone; with its space and "up" the line measures 24px). */
export const DELTA_CUE_PX = 7;

/** The width of each of a KPI row's four columns at `fontPx`: the widest of its figure and its tile's other content. */
export function kpiColumnMinPx(tiles: readonly KpiTile[], scale: MoneyScale, fontPx: number): number[] {
  const widest = [0, 0, 0, 0];
  tiles.forEach((tile, i) => {
    const figure = tile.figure.value === null ? 0 : textPx(formatFigureText(tile.figure, scale), fontPx, 500);
    widest[i % 4] = Math.max(widest[i % 4]!, figure, tileOtherMinPx(tile));
  });
  return widest;
}

export const KPI_GAP_PX = GUTTER_MM * MM_PX;

export function kpiFit(tiles: readonly KpiTile[], scale: MoneyScale, orientation: PageOrientation = 'portrait'): FigureFit {
  const ceilingPx = ptToPx(KPI_FIGURE_MAX_PT);
  const floor = Math.round(ptToPx(KPI_FIGURE_FLOOR_PT));
  const total = (px: number) => kpiColumnMinPx(tiles, scale, px).reduce((a, b) => a + b, 0) + 3 * KPI_GAP_PX;
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
