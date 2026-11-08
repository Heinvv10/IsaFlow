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
 * Words are the shaped widths of `packFigureWidth.ts`; a heading's too, with its tracking (`HEADING_WORDS_PX`). The
 * table is as wide as production prints a page (`PRINT_CONTENT_PX`).
 */
import { createHash } from 'node:crypto';
import type { MoneyScale } from '@/lib/format/money';
import { notMeaningfulNotesMm } from './packBlockHeights';
import {
  CELL_SIDE_PX, cellPx, headingLineExactPx, headingLinePx, headingMarkExactPx, headingMarkPx, headingWordsPx, INDENT_PX_PER_LEVEL,
  labelMarkExactPx, labelMarkPx, labelWidestPiecePx, ROW_WEIGHT, tableColumnCells, tableFit, TABLE_FIGURE_MAX_PT, type FigureCell,
} from './packFigureFit';
import { ptToPx, textExactPx, textPx } from './packFigureWidth';
import { AS_CHROMIUM_SETS } from './packGlyphRuler';
import { linesForText, minPx, WRAP_GUARD } from './packLineWrap';
import { pieces } from './packLineBreaks';
import type { PackTable, PackTableColumnKey, PackTableRow } from './packPageModel';
import { PACK_TABLE_COLUMN_LABEL } from './packTableModel';
import { PRINT_CONTENT_PX, type PageOrientation } from './packTextMetrics';

/**
 * Each column heading's words in pixels, as `.pack-table th` sets them (8pt, weight 500, uppercase, 0.06em tracking),
 * shaped from the face (`packFigureFit.headingWordsPx`). A line of a heading is shaped whole (`headingLinePx`).
 * `packTableLayout.test.ts` holds them to Chromium.
 */
export const HEADING_WORDS_PX: Readonly<Record<PackTableColumnKey, readonly number[]>> = Object.fromEntries(
  (Object.entries(PACK_TABLE_COLUMN_LABEL) as Array<[PackTableColumnKey, string]>).map(([col, label]) => [col, headingWordsPx(label)]),
) as unknown as Record<PackTableColumnKey, readonly number[]>;

const LABEL_FONT_PX = Math.round(ptToPx(TABLE_FIGURE_MAX_PT));

export interface TableLayout {
  /** The label column's width then each data column's, in pixels. */
  readonly columnsPx: readonly number[];
  /** The lines each row's label takes, in row order. */
  readonly labelLines: readonly number[];
  /** The most lines any column heading takes. */
  readonly headingLines: number;
}

/**
 * The layout of `table`. The figures are at the size the fit sets (a decision that must never be short). The columns
 * are shared out from widths as Chromium sets them (`AS_CHROMIUM_SETS`), so they are Chromium's to within a few
 * hundredths of a pixel; whether a line still holds a piece is decided the way Chromium's line breaker decides it
 * (`fitUnitsPx`: the line's boxes summed exactly, floored once), against the column less the guard (`WRAP_GUARD`, the
 * columns' error). The columns are shared out
 * in Chromium's 1/64px unit: each column's share truncated to it, the last column taking what is left.
 */
export function tableLayout(table: PackTable, scale: MoneyScale, orientation: PageOrientation, guardPx: number = WRAP_GUARD[orientation]): TableLayout {
  // Composing a page asks for the same table's layout at every step of `fitPageToBox`; it is a function of what the
  // table prints, so it is kept by that (never by identity: a table edited in place is another table).
  const inputs = layoutInputs(table, scale);
  const key = createHash('sha1').update(JSON.stringify([scale, orientation, guardPx, inputs])).digest('hex');
  const known = LAYOUTS.get(key);
  if (known !== undefined) {
    // Least recently used goes first: a hit moves to the back.
    LAYOUTS.delete(key);
    LAYOUTS.set(key, known);
    return known;
  }
  const fitPx = tableFit(table, scale, orientation).px ?? Math.round(ptToPx(TABLE_FIGURE_MAX_PT));
  const { columnsPx, labelLines, headingLines } = layoutAt(inputs, orientation, guardPx, fitPx);
  const layout: TableLayout = Object.freeze({ columnsPx: Object.freeze(columnsPx), labelLines: Object.freeze(labelLines), headingLines });
  if (LAYOUTS.size >= LAYOUTS_MAX) LAYOUTS.delete(LAYOUTS.keys().next().value!);
  LAYOUTS.set(key, layout);
  return layout;
}

/** Layouts kept, by `layoutKey`; at most `LAYOUTS_MAX` (a few pages' tables, many times over), least recent dropped. */
const LAYOUTS = new Map<string, TableLayout>();
export const LAYOUTS_MAX = 200;
/** How many layouts are kept (for the bound's test). */
export const keptLayouts = (): number => LAYOUTS.size;

/**
 * EVERYTHING A LAYOUT READS, and the only thing `layoutAt` is given, so the key (a hash of it, with the scale, orientation
 * and guard) cannot leave out something the layout depends on: the columns that print (a column with no figure on any
 * row is dropped, and which ones survive changes the headings and widths), each column's heading note, each row's
 * label, level, role and footnote, and the text of every cell (`tableColumnCells`, what the figures become). The figure
 * size (`tableFit`) is a function of these and the orientation. A hash, so a kept layout costs 40 characters, not the
 * table's figures.
 */
interface LayoutInputs {
  columns: PackTableColumnKey[];
  headingNotes: Array<number | null>;
  rows: Array<{ label: string; level: number; role: PackTableRow['role']; footnote: number | null }>;
  cells: FigureCell[][];
}

function layoutInputs(table: PackTable, scale: MoneyScale): LayoutInputs {
  const columns = table.columns.filter((col) => table.rows.some((row) => row.figures[col] !== undefined));
  return {
    columns,
    headingNotes: columns.map((col) => table.columnNotes?.find((n) => n.column === col)?.footnote ?? null),
    rows: table.rows.map((r) => ({ label: r.label, level: r.level, role: r.role, footnote: r.footnote ?? null })),
    cells: tableColumnCells(table, scale),
  };
}

/**
 * The columns' widths, as Chromium's automatic table layout shares the sheet out: where the MAXes fit, each is its max
 * plus a share of what is left in proportion to its max; where not even the MINs fit, each is its min; otherwise each
 * is its min plus a share of the room left over in proportion to `max - min`. Every share is truncated to Chromium's
 * 1/64px unit, and the last column takes what is left, so the columns fill the sheet exactly.
 */
function shareOut(mins: readonly number[], maxs: readonly number[], sheet: number): number[] {
  const sumMin = mins.reduce((a, b) => a + b, 0);
  const sumMax = maxs.reduce((a, b) => a + b, 0);
  if (sumMax > sheet && sumMin >= sheet) return [...mins];
  const fromMax = sumMax <= sheet;
  const base = fromMax ? maxs : mins;
  const room = sheet - (fromMax ? sumMax : sumMin);
  const weight = (i: number): number => (fromMax ? maxs[i]! / sumMax : (maxs[i]! - mins[i]!) / (sumMax - sumMin));
  const unit = (px: number): number => Math.trunc(px * 64 + 1e-6) / 64;
  let given = 0;
  return base.map((width, i) => {
    const extra = i === base.length - 1 ? room - given : unit(room * weight(i));
    given += extra;
    return width + extra;
  });
}

function layoutAt(inputs: LayoutInputs, orientation: PageOrientation, guardPx: number, fitPx: number): TableLayout {
  const { columns, cells } = inputs;
  const labelBox = inputs.rows.map((row) => {
    const weight = ROW_WEIGHT[row.role];
    const parts = pieces(row.label);
    const line = (text: string, hyphen: boolean): number => textExactPx(text, LABEL_FONT_PX, weight, hyphen);
    const indent = row.level * INDENT_PX_PER_LEVEL;
    const marker = labelMarkPx(row.footnote, weight, AS_CHROMIUM_SETS);
    return {
      indent, parts, line, markerLine: labelMarkExactPx(row.footnote, weight),
      min: indent + labelWidestPiecePx(row.label, row.footnote, weight, AS_CHROMIUM_SETS) + CELL_SIDE_PX,
      max: indent + textPx(row.label.trim().replace(/[ \t\n\r]+/g, ' '), LABEL_FONT_PX, weight, false, AS_CHROMIUM_SETS) + marker + CELL_SIDE_PX,
    };
  });
  const labelMin = Math.max(0, ...labelBox.map((b) => b.min));
  const labelMax = Math.max(0, ...labelBox.map((b) => b.max));
  const data = columns.map((col, i) => {
    const figures = Math.max(0, ...cells[i]!.map((cell) => cellPx(cell, fitPx, AS_CHROMIUM_SETS)));
    const footnote = inputs.headingNotes[i] ?? undefined;
    const marker = headingMarkPx(footnote, AS_CHROMIUM_SETS);
    const label = PACK_TABLE_COLUMN_LABEL[col];
    return {
      col, parts: pieces(label), markerLine: headingMarkExactPx(footnote),
      min: Math.max(figures, minPx(headingWordsPx(label, AS_CHROMIUM_SETS).map((w) => ({ w })), marker)) + 2 * CELL_SIDE_PX,
      max: Math.max(figures, headingLinePx(label, AS_CHROMIUM_SETS) + marker) + 2 * CELL_SIDE_PX,
    };
  });
  const mins = [labelMin, ...data.map((d) => d.min)];
  const maxs = [labelMax, ...data.map((d) => d.max)];
  const columnsPx = shareOut(mins, maxs, PRINT_CONTENT_PX[orientation]);
  const labelPx = columnsPx[0]!;
  const labelLines = labelBox.map((b) => linesForText(b.parts, b.line, b.markerLine, labelPx - b.indent - CELL_SIDE_PX, guardPx));
  // A column heading is a fixed English label: no soft hyphen, so no hyphen to set.
  const headingLine = (text: string): number => headingLineExactPx(text);
  const headingLines = Math.max(1, ...data.map((d, i) => linesForText(d.parts, headingLine, d.markerLine, columnsPx[i + 1]! - 2 * CELL_SIDE_PX, guardPx)));
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
