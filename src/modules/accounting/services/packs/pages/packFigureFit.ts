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
import { runPx } from './packGlyphRuler';
import { PACK_TABLE_COLUMN_LABEL } from './packTableModel';
import { pieces } from './packLineBreaks';
import { reasonPx } from './packReasonWidth';
import { deltaWithWord } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import { deltaDirection } from '@/modules/accounting/services/packs/narrative/derivedTileCaptions';
import type { PackPageBlock, PackTable, PackTableColumnKey, PackTableRow } from './packPageModel';
import { PRINT_CONTENT_PX, type PageOrientation } from './packTextMetrics';
import { FIT_PX, TABLE_FIGURE_MAX_PT, type FigureFit } from './packFigureFitCss';

export { KPI_FIGURE_FLOOR_PT, KPI_FIGURE_MAX_PT, TABLE_FIGURE_FLOOR_PT, TABLE_FIGURE_MAX_PT } from './packFigureFitCss';

const MM_PX = 96 / 25.4;
/** `.pack-table td` / `th`: 2mm either side. */
const CELL_SIDE_PX = 2 * MM_PX;
/** `.pack-table td:first-child` indents by `level x 4mm` (`INDENT_MM_PER_LEVEL`). */
const INDENT_PX_PER_LEVEL = 4 * MM_PX;
/** A not-meaningful cell is "n/m" and the mark of its note (`.pack-table-note-mark`). */
const NOT_MEANINGFUL = 'n/m';

/**
 * A FOOTNOTE MARK, AT THE SIZE IT IS SET AT. `.pack-footnote-marker` and `.pack-table-note-mark` are 0.7em superscripts
 * of their host, shaped like any run at that size (`packFigureWidth.textPxUnsnapped`). `packFigureWidth.test.ts`
 * holds a label or an n/m cell with its mark to Chromium.
 */
const markPx = (text: string, hostPx: number, weight: FigureWeight): number => textPxUnsnapped(text, 0.7 * hostPx, weight);
/** A row's or KPI tile's footnote number after its 9pt label. */
export const labelMarkPx = (number: number | null | undefined, weight: FigureWeight = 400): number => (number === null || number === undefined ? 0 : markPx(String(number), 12, weight));

/** `.pack-table th`: 8pt, weight 500, uppercase, 0.06em letter-spacing (which a superscript inherits as computed). */
const HEADING_PX = ptToPx(8);
const HEADING_TRACKING_PX = 0.06 * HEADING_PX;
const headingRunPx = (text: string, fontPx: number): number => runPx(text, fontPx, 500,
  (cluster, sizePx) => textPx(cluster, sizePx, 500) + HEADING_TRACKING_PX, HEADING_TRACKING_PX);
/** A heading's footnote number: 0.7em of the 8pt heading, tracked like it. */
export const headingMarkPx = (number: number | undefined): number => (number === undefined ? 0 : headingRunPx(String(number), 0.7 * HEADING_PX));

/**
 * The longest word of each column heading, in pixels, as `.pack-table th` sets it (a heading wraps, so its min-content
 * is its longest word), shaped from the face with the heading's tracking. `packFigureWidth.test.ts` holds it to Chromium.
 */
export const HEADING_WORD_PX: Readonly<Record<PackTableColumnKey, number>> = Object.fromEntries(
  (Object.entries(PACK_TABLE_COLUMN_LABEL) as Array<[PackTableColumnKey, string]>).map(([col, label]) => [col,
    Math.max(...label.split(' ').map((word) => headingRunPx(word.toUpperCase(), HEADING_PX)))]),
) as Record<PackTableColumnKey, number>;

export { fitAttributes, type FigureFit } from './packFigureFitCss';

/**
 * The width a row's columns may take: the width production prints a page's content at (`PRINT_CONTENT_PX`, measured
 * in its Gotenberg image). Every width the model sums is never short of Chromium's, so no slack is kept off it.
 */
const measurePx = (orientation: PageOrientation): number => PRINT_CONTENT_PX[orientation];

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

/**
 * The narrowest a 9pt label (a statement row's, a KPI tile's) can be set: its widest piece, with the footnote mark
 * after the LAST piece, not the longest. Chromium never breaks between a word and the `<sup>` after it, so the mark
 * wraps with the last piece (`packLabelMark.test.ts`).
 */
export function labelWidestPiecePx(label: string, footnote: number | null | undefined, weight: FigureWeight): number {
  const widths = pieces(label).map((piece) => textPx(piece.text, Math.round(ptToPx(TABLE_FIGURE_MAX_PT)), weight, piece.hyphen));
  const mark = labelMarkPx(footnote, weight);
  return Math.max(0, ...widths.map((w, i) => (i === widths.length - 1 ? w + mark : w)));
}

/** The narrowest a row label can be set: its widest piece and marker (it wraps), its indent, its right padding. */
function labelMinPx(table: PackTable): number {
  return Math.max(0, ...table.rows.map((row) => row.level * INDENT_PX_PER_LEVEL
    + labelWidestPiecePx(row.label, row.footnote, ROW_WEIGHT[row.role]) + CELL_SIDE_PX));
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
  const { ordinary: ceiling, floor } = FIT_PX.table;
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

/** The longest unbreakable run of `text` (`packLineBreaks.ts`, the one splitter), with the hyphen a soft one sets. */
function longestRunPx(text: string, fontPx: number, weight: FigureWeight): number {
  return Math.max(0, ...pieces(text).map((piece) => textPx(piece.text, fontPx, weight, piece.hyphen)));
}

/**
 * The narrowest a tile can be set apart from its figure: its label's longest run at 9pt (with its footnote marker),
 * its not-meaningful reason's at 11pt (italic: its own advances, `packReasonWidth.ts`) and its delta line's at 9pt after
 * the 7pt arrow. A `1fr` grid column is never narrower than any of them, so a short figure under a long word still
 * holds its column open (the adversary's net-debit Debt-to-equity tile: 50px of figure under a 56px label).
 */
function tileOtherMinPx(tile: KpiTile): number {
  const labelPx = labelWidestPiecePx(tile.label, tile.trendFootnote, 400);
  const reasonWidth = tile.figure.value === null && tile.figure.unavailable !== undefined && tile.figure.unavailable !== null
    ? Math.max(0, ...pieces(tile.figure.unavailable).map((piece) => reasonPx(piece.text, piece.hyphen))) : 0;
  // The arrow cue is a run of its own (`</span>{' '}` after it is a break opportunity): it never holds a column open
  // past the words it precedes.
  const deltaPx = tile.delta === null ? 0 : Math.max(DELTA_CUE_PX, longestRunPx(deltaText(tile), 12, 400));
  return Math.max(labelPx, reasonWidth, deltaPx);
}
/** The arrow cue before a delta, a 7pt glyph: the widest of the three arrows the tile sets. */
export const DELTA_CUE_PX = Math.max(...['\u2191', '\u2193', '\u2192'].map((arrow) => textPx(arrow, ptToPx(7), 400)));

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
  const { ordinary: ceilingPx, floor } = FIT_PX.kpi;
  const total = (px: number) => kpiColumnMinPx(tiles, scale, px).reduce((a, b) => a + b, 0) + 3 * KPI_GAP_PX;
  if (total(ceilingPx) <= measurePx(orientation)) return { px: null, fits: true };
  for (let px = Math.floor(ceilingPx); px >= floor; px -= 1) {
    if (total(px) <= measurePx(orientation)) return { px, fits: true };
  }
  return { px: floor, fits: false };
}
