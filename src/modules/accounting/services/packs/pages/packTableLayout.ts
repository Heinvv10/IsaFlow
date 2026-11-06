/**
 * HOW CHROMIUM LAYS OUT A STATEMENT TABLE, SO THE FIT MODEL KNOWS ITS HEIGHT.
 *
 * A statement table's height is not rows times a constant: the label column and the column headings WRAP, and
 * how often depends on the width every column is given. Page 6 of a budget company is eight columns wide, and
 * at k=30 and k=1,000 its label "Operating expenses" wraps to a second line and its headings ("Variance",
 * "Budget", "% of Revenue") to two lines, which the model (a flat 40% label share, one heading line) never saw:
 * the table measured 77.5mm in Chromium against the model's 73.2 and the sheet ran 3.8mm past its foot.
 *
 * The width each column gets is Chromium's automatic table layout, which was measured to the pixel on the 8
 * column page-6 table (`packTableLayout.test.ts` holds it to Chromium on every table of the grid):
 *  - every column has a MIN (the narrowest it can be set: its widest figure, its heading's longest word, its
 *    label's longest word) and a MAX (nothing wraps: its widest figure, the whole heading, the whole label), each
 *    with its cell padding;
 *  - the table is as wide as the sheet; where the MAXes fit they are scaled up in proportion to fill it, and
 *    where they do not each column gets its MIN plus its share of the room left over, in proportion to
 *    `MAX - MIN`.
 * Words are the exact pixel widths of `packFigureWidth.ts`; a heading's are measured (`HEADING_WORDS_PX`).
 */
import type { MoneyScale } from '@/lib/format/money';
import { notMeaningfulNotesMm } from './packBlockHeights';
import {
  CELL_SIDE_PX, cellPx, HEADING_MARKER_PX, INDENT_PX_PER_LEVEL, LABEL_MARKER_PX, MM_PX, ROW_WEIGHT,
  tableColumnCells, tableFit, TABLE_FIGURE_MAX_PT,
} from './packFigureFit';
import { ptToPx, textPx } from './packFigureWidth';
import type { PackTable, PackTableColumnKey, PackTableRow } from './packPageModel';
import { PAGE_WIDTH_MM, type PageOrientation } from './packTextMetrics';

/**
 * Each column heading's words in pixels, as `.pack-table th` sets them (8pt, uppercase, 0.06em tracking), and
 * the width of a space between two of them. A line of a heading is the sum of its words and spaces.
 * Measured in Chromium by `packTableLayout.test.ts`, which fails if one drifts.
 */
export const HEADING_WORDS_PX: Readonly<Record<PackTableColumnKey, readonly number[]>> = {
  actual: [44.85], prior: [37.21], change: [48.85], changePct: [48.85, 10.65], pctOfRevenue: [10.65, 15.29, 55.49],
  budget: [47.85], variance: [59.13], revenue: [55.49], otherIncome: [39.21, 47.85], costOfSales: [30.57, 15.29, 37.21],
  monthOperatingExpenses: [67.77], otherExpenses: [39.21], netProfit: [22.93, 42.85],
};
export const HEADING_SPACE_PX = 3.65;

const LABEL_FONT_PX = Math.round(ptToPx(TABLE_FIGURE_MAX_PT));

export interface TableLayout {
  /** The label column's width then each data column's, in pixels. */
  columnsPx: number[];
  /** The lines each row's label takes, in row order. */
  labelLines: number[];
  /** The most lines any column heading takes. */
  headingLines: number;
}

/** One breakable piece of text: its width, and the gap before it where it does not follow a hyphen. */
interface Run { w: number; gap: number }

/** The runs a label may break between: at spaces (a space apart), and after a hyphen (touching). */
function labelRuns(row: PackTableRow, space: number): Run[] {
  const weight = ROW_WEIGHT[row.role];
  return row.label.split(/\s+/).filter((word) => word !== '').flatMap((word, wi) => word.split(/(?<=-)/)
    .map((run, ri) => ({ w: textPx(run, LABEL_FONT_PX, weight), gap: wi > 0 && ri === 0 ? space : 0 })));
}

const totalPx = (runs: readonly Run[]): number => runs.reduce((sum, r) => sum + r.gap + r.w, 0);

/** A greedy fill of `runs` into lines of `avail`; `marker` is a footnote mark that stays with the last run. */
function linesFor(runs: readonly Run[], marker: number, avail: number): number {
  let lines = 1;
  let used = 0;
  runs.forEach((run, i) => {
    const w = run.w + (i === runs.length - 1 ? marker : 0);
    if (i > 0 && used + run.gap + w > avail + 0.01) { lines += 1; used = w; } else used += run.gap + w;
  });
  return lines;
}

export function tableLayout(table: PackTable, scale: MoneyScale, orientation: PageOrientation): TableLayout {
  const columns = table.columns.filter((col) => table.rows.some((row) => row.figures[col] !== undefined));
  const fitPx = tableFit(table, scale, orientation).px ?? Math.round(ptToPx(TABLE_FIGURE_MAX_PT));
  const cells = tableColumnCells(table, scale);
  const notes = new Set((table.columnNotes ?? []).map((n) => n.column));
  const space = textPx(' ', LABEL_FONT_PX, 400);
  const labelBox = table.rows.map((row) => {
    const runs = labelRuns(row, space);
    const marker = row.footnote === undefined ? 0 : LABEL_MARKER_PX;
    const indent = row.level * INDENT_PX_PER_LEVEL;
    return {
      indent, marker, runs,
      min: indent + Math.max(0, ...runs.map((r) => r.w)) + marker + CELL_SIDE_PX,
      max: indent + totalPx(runs) + marker + CELL_SIDE_PX,
    };
  });
  const labelMin = Math.max(0, ...labelBox.map((b) => b.min));
  const labelMax = Math.max(0, ...labelBox.map((b) => b.max));
  const data = columns.map((col, i) => {
    const figures = Math.max(0, ...cells[i]!.map((cell) => cellPx(cell, fitPx)));
    const marker = notes.has(col) ? HEADING_MARKER_PX : 0;
    const words = HEADING_WORDS_PX[col];
    const full = words.reduce((sum, w) => sum + w, 0) + HEADING_SPACE_PX * (words.length - 1) + marker;
    return {
      col, words, marker,
      min: Math.max(figures, Math.max(...words) + marker) + 2 * CELL_SIDE_PX,
      max: Math.max(figures, full) + 2 * CELL_SIDE_PX,
    };
  });
  const mins = [labelMin, ...data.map((d) => d.min)];
  const maxs = [labelMax, ...data.map((d) => d.max)];
  const sumMin = mins.reduce((a, b) => a + b, 0);
  const sumMax = maxs.reduce((a, b) => a + b, 0);
  const sheet = PAGE_WIDTH_MM[orientation] * MM_PX;
  const columnsPx = mins.map((min, i) => {
    const max = maxs[i]!;
    if (sumMax <= sheet) return max + ((sheet - sumMax) * max) / sumMax;
    if (sumMin >= sheet) return min;
    return min + ((sheet - sumMin) * (max - min)) / (sumMax - sumMin);
  });
  const labelPx = columnsPx[0]!;
  const labelLines = labelBox.map((b) => linesFor(b.runs, b.marker, labelPx - b.indent - CELL_SIDE_PX));
  const headingLines = Math.max(1, ...data.map((d, i) => linesFor(
    d.words.map((w, j) => ({ w, gap: j === 0 ? 0 : HEADING_SPACE_PX })), d.marker, columnsPx[i + 1]! - 2 * CELL_SIDE_PX)));
  return { columnsPx, labelLines, headingLines };
}

/**
 * WHAT A STATEMENT TABLE'S PARTS COST ON PAPER, measured in Chromium over 864 tables of the pack grid
 * (`packTableLayout.test.ts` holds each to it, and the table's height is exactly the sum of its parts):
 * the caption 4.585mm; the heading row 7.359mm, 4.233 more for every extra line (12pt leading); a body row 6.98
 * to 7.115mm (a line, a total), 7.247 (a subtotal: a heavier rule), 8.04 (a grand total: a double rule), and
 * up to 4.585 more for every extra line of its label (13pt leading; a wrapped row measures 11.567 or 11.700). Each is charged rounded up to the hundredth.
 *
 * It replaces a flat 8mm heading and 8.15mm per row, which over-charged a table that does not wrap by about
 * 4.4mm and, because the caption and the extra lines were charged nowhere, still under-charged one that does.
 */
const CAPTION_MM = 4.59;
const HEAD_MM = 7.36;
const HEAD_LINE_MM = 4.24;
const LABEL_LINE_MM = 4.59;
const ROW_MM: Readonly<Record<PackTableRow['role'], number>> = { line: 7.12, subtotal: 7.25, total: 7.12, grandTotal: 8.05 };

/** The `table` element's own height: its caption, its headings and its rows at the lines Chromium sets them in. */
export function statementTableBodyMm(table: PackTable, scale: MoneyScale, orientation: PageOrientation): number {
  const layout = tableLayout(table, scale, orientation);
  const body = table.rows.reduce((sum, row, i) => sum + ROW_MM[row.role] + (layout.labelLines[i]! - 1) * LABEL_LINE_MM, 0);
  return CAPTION_MM + HEAD_MM + (layout.headingLines - 1) * HEAD_LINE_MM + body;
}

/** A statement table's height as the page carries it: the table, and the reasons list printed under it. */
export function statementTableMm(table: PackTable, scale: MoneyScale, orientation: PageOrientation, widthMm: number): number {
  const figures = table.rows.flatMap((r) => table.columns.map((c) => r.figures[c]));
  return statementTableBodyMm(table, scale, orientation) + notMeaningfulNotesMm(figures, widthMm);
}
