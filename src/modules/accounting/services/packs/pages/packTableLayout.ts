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
  CELL_SIDE_PX, cellPx, headingMarkPx, INDENT_PX_PER_LEVEL, labelMarkPx, MM_PX, ROW_WEIGHT,
  tableColumnCells, tableFit, TABLE_FIGURE_MAX_PT,
} from './packFigureFit';
import { ptToPx, textPx } from './packFigureWidth';
import { linesFor, minPx, runsOf, totalPx, WRAP_GUARD_PX, type Run } from './packLineWrap';
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

/** The runs a label may break between (`packLineWrap.ts`). */
function labelRuns(row: PackTableRow, space: number): Run[] {
  const weight = ROW_WEIGHT[row.role];
  return runsOf(row.label, (piece) => textPx(piece, LABEL_FONT_PX, weight), space);
}

export function tableLayout(table: PackTable, scale: MoneyScale, orientation: PageOrientation, guardPx: number = WRAP_GUARD_PX): TableLayout {
  const columns = table.columns.filter((col) => table.rows.some((row) => row.figures[col] !== undefined));
  const fitPx = tableFit(table, scale, orientation).px ?? Math.round(ptToPx(TABLE_FIGURE_MAX_PT));
  const cells = tableColumnCells(table, scale);
  const space = textPx(' ', LABEL_FONT_PX, 400);
  const labelBox = table.rows.map((row) => {
    const runs = labelRuns(row, space);
    const marker = labelMarkPx(row.footnote, ROW_WEIGHT[row.role]);
    const indent = row.level * INDENT_PX_PER_LEVEL;
    return {
      indent, marker, runs,
      min: indent + minPx(runs, marker) + CELL_SIDE_PX,
      max: indent + totalPx(runs) + marker + CELL_SIDE_PX,
    };
  });
  const labelMin = Math.max(0, ...labelBox.map((b) => b.min));
  const labelMax = Math.max(0, ...labelBox.map((b) => b.max));
  const data = columns.map((col, i) => {
    const figures = Math.max(0, ...cells[i]!.map((cell) => cellPx(cell, fitPx)));
    const marker = headingMarkPx(table.columnNotes?.find((n) => n.column === col)?.footnote);
    const words = HEADING_WORDS_PX[col];
    const full = words.reduce((sum, w) => sum + w, 0) + HEADING_SPACE_PX * (words.length - 1) + marker;
    return {
      col, words, marker,
      min: Math.max(figures, minPx(words.map((w) => ({ w, gap: 0 })), marker)) + 2 * CELL_SIDE_PX,
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
  const labelLines = labelBox.map((b) => linesFor(b.runs, b.marker, labelPx - b.indent - CELL_SIDE_PX, guardPx));
  const headingLines = Math.max(1, ...data.map((d, i) => linesFor(
    d.words.map((w, j) => ({ w, gap: j === 0 ? 0 : HEADING_SPACE_PX })), d.marker, columnsPx[i + 1]! - 2 * CELL_SIDE_PX, guardPx)));
  return { columnsPx, labelLines, headingLines };
}

/**
 * WHAT A STATEMENT TABLE'S PARTS COST ON PAPER, measured in Chromium (`packTableLayout.test.ts` holds each to it over
 * hundreds of tables, and the table's height is exactly the sum of its parts):
 *  - the caption 4.585mm; the heading row 7.359mm, 4.233 more for every extra line (12pt leading);
 *  - a body row is 6.983mm of padding and one 13pt line, 4.586 more for every extra line of its label, PLUS half of
 *    each border it shares with its neighbours. The table is `border-collapse: collapse`, so two rows meet at ONE
 *    border, as wide as the wider of the bottom of the row above and the top of the row below, and each row carries
 *    half of it. Borders are snapped to device pixels (0.2646mm): the rule above a subtotal, total or grand total is
 *    1pt = 1px, the double rule under a grand total 3pt = 4px, the heading's rule under it 1px. So a lone total after
 *    a line is 6.983 + 0.5px, two grand totals in a row are 6.983 + 4px each (8.041mm), and a row of plain lines
 *    carries no border at all (6.983). The rule under the LAST row is shared with the table's edge: the row carries half
 *    and the table the other half (a grand total last adds 2px, 0.53mm).
 * Each is charged rounded up to the hundredth.
 *
 * It replaces a flat 8mm heading and 8.15mm per row, which over-charged a table that does not wrap by about 4.4mm
 * and, because the caption, the extra lines and the shared rules were charged nowhere, still under-charged one that does.
 */
const CAPTION_MM = 4.59;
const HEAD_MM = 7.36;
const HEAD_LINE_MM = 4.24;
const LABEL_LINE_MM = 4.59;
const ROW_BASE_MM = 6.99;
const BORDER_PX_MM = 0.2646;
/** The rule above a subtotal / total / grand total (1pt), and the double rule under a grand total (3pt), in pixels. */
const TOP_RULE_PX: Readonly<Record<PackTableRow['role'], number>> = { line: 0, subtotal: 1, total: 1, grandTotal: 1 };
const BOTTOM_RULE_PX: Readonly<Record<PackTableRow['role'], number>> = { line: 0, subtotal: 0, total: 0, grandTotal: 4 };
/** The heading row's rule over the first body row. */
const HEAD_RULE_PX = 1;

/** The border (px) at the boundary above row `i`: the wider of what ends the row above and what starts this one. */
function boundaryPx(rows: readonly PackTableRow[], i: number): number {
  const above = i === 0 ? HEAD_RULE_PX : BOTTOM_RULE_PX[rows[i - 1]!.role];
  const below = i === rows.length ? 0 : TOP_RULE_PX[rows[i]!.role];
  return Math.max(above, below);
}

/** The `table` element's own height: its caption, its headings and its rows at the lines Chromium sets them in. */
export function statementTableBodyMm(table: PackTable, scale: MoneyScale, orientation: PageOrientation): number {
  const layout = tableLayout(table, scale, orientation);
  const body = table.rows.reduce((sum, row, i) => sum
    + ROW_BASE_MM + ((boundaryPx(table.rows, i) + boundaryPx(table.rows, i + 1)) / 2) * BORDER_PX_MM
    + (layout.labelLines[i]! - 1) * LABEL_LINE_MM, 0);
  // The rule under the last row is shared with the table's own edge: the row carries half, the table the other half.
  const tail = (boundaryPx(table.rows, table.rows.length) / 2) * BORDER_PX_MM;
  return CAPTION_MM + HEAD_MM + (layout.headingLines - 1) * HEAD_LINE_MM + body + tail;
}

/** A statement table's height as the page carries it: the table, and the reasons list printed under it. */
export function statementTableMm(table: PackTable, scale: MoneyScale, orientation: PageOrientation, widthMm: number): number {
  const figures = table.rows.flatMap((r) => table.columns.map((c) => r.figures[c]));
  return statementTableBodyMm(table, scale, orientation) + notMeaningfulNotesMm(figures, widthMm);
}
