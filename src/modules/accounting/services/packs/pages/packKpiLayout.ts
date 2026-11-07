/**
 * HOW CHROMIUM LAYS OUT A ROW OF KPI TILES, SO THE FIT MODEL KNOWS ITS HEIGHT.
 *
 * `.pack-kpi-tiles` is `repeat(4, 1fr)` over `nowrap` figures, so its columns are the grid algorithm's: a column
 * whose min-content (its figure, its label's longest word, its reason's, its delta's: `kpiColumnMinPx`) is wider
 * than the equal share keeps that width, and the rest share what is left. A tile is a flex column with a 1mm gap:
 * its label, then its figure or its not-meaningful reason, then its delta line, then its sparkline, each as tall as
 * the lines Chromium breaks it into at the column's width. A row is as tall as its tallest tile. The row is as wide
 * as production prints the page (`PRINT_CONTENT_PX`, 658px portrait, 987 landscape), not the 174mm (657.6px) of the margins.
 *
 * The model it replaces charged every tile as if it sat in a quarter, took its text from the prose ruler and its
 * sparkline at the 33mm cap, and read 5.6 to 52.7mm too tall on the page-3 packs where master keeps fewer notes than
 * it needs to: a block that prints inside its sheet was dropped for room the sheet had.
 *
 * `packKpiLayout.test.ts` holds every column width, every tile and the block's height to Chromium.
 */
import type { MoneyScale } from '@/lib/format/money';
import { GUTTER_MM } from './packDisclosureHeight';
import {
  DELTA_CUE_PX, deltaText, kpiColumnMinPx, kpiFit, KPI_GAP_PX, KPI_FIGURE_MAX_PT, labelMarkPx, MM_PX, type KpiTile,
} from './packFigureFit';
import { ptToPx, textPx } from './packFigureWidth';
import { pieces } from './packLineBreaks';
import { reasonPx } from './packReasonWidth';
import { PRINT_CONTENT_PX, type PageOrientation } from './packTextMetrics';

/** One CSS pixel, in mm. */
const PX_MM = 25.4 / 96;
/**
 * Leadings, as Chromium sets them in its 1/64px unit (`packKpiLeadings.test.ts` re-measures each): a label or a delta
 * line is 12pt, 16px; a not-meaningful reason line 14pt, 18.667px, set at 18.671875; a figure 25pt, 33.333px, set at
 * 33.328125. The delta's first line is 1px taller: its arrow cue sits in a 7pt run.
 */
export const LABEL_LINE_MM = 16 * PX_MM;
export const REASON_LINE_MM = 18.671875 * PX_MM;
export const FIGURE_LINE_MM = 33.328125 * PX_MM;
export const DELTA_CUE_MM = 1 * PX_MM;
/** `.pack-kpi-tile { gap: 1mm }`: Chromium floors it to its unit (3.765625px); the model charges the millimetre. */
const TILE_GAP_MM = 1;
/** `.pack-kpi-sparkline svg { max-height: 33mm }`. */
const SPARKLINE_MAX_MM = 33;
const TEXT_PX = 12;

/**
 * The sparkline's height over its width, from the width and height the chart renderer wrote on its root `<svg>`
 * (`renderChartSvg`; `packKpiLayoutModel.test.ts` pins that format). An SVG without them is a renderer this model was
 * not built against: refused, not guessed at.
 */
function sparklineAspect(svg: string): number {
  const w = /<svg[^>]* width="(\d+(?:\.\d+)?)"/.exec(svg);
  const h = /<svg[^>]* height="(\d+(?:\.\d+)?)"/.exec(svg);
  if (w === null || h === null || Number(w[1]) <= 0) throw new Error('packKpiLayout: a sparkline SVG without a numeric width and height on its root element');
  return Number(h[1]) / Number(w[1]);
}

/**
 * The size `.pack-kpi-value` sets a row's figures at, in px: 22pt, or the whole-pixel size the figure fit stamped on
 * the row (`packFigureFit.kpiFit`, `.pack-kpi-tiles.is-fitted`). Nothing in it comes from the content width
 * (`tests/unit/print/packKpiFigureSize.test.ts` holds it to Chromium's computed size).
 */
export function kpiFigurePx(tiles: readonly KpiTile[], scale: MoneyScale, orientation: PageOrientation): number {
  return kpiFit(tiles, scale, orientation).px ?? ptToPx(KPI_FIGURE_MAX_PT);
}

/** The width of each of the four columns, in pixels: the grid's `1fr` tracks over their min-content widths. */
export function kpiColumnsPx(tiles: readonly KpiTile[], scale: MoneyScale, orientation: PageOrientation): number[] {
  const mins = kpiColumnMinPx(tiles, scale, kpiFigurePx(tiles, scale, orientation));
  const room = PRINT_CONTENT_PX[orientation] - 3 * KPI_GAP_PX;
  const frozen = mins.map(() => false);
  let share = room / 4;
  for (let again = true; again;) {
    again = false;
    const free = frozen.filter((f) => !f).length;
    share = free === 0 ? 0 : (room - mins.reduce((sum, m, i) => sum + (frozen[i] ? m : 0), 0)) / free;
    mins.forEach((m, i) => { if (!frozen[i] && m > share) { frozen[i] = true; again = true; } });
  }
  return mins.map((m, i) => (frozen[i] ? m : share));
}

/**
 * How many lines Chromium sets `text` in, `avail` px wide: a greedy fill over the places it may break (`pieces`), each
 * candidate line measured as ONE string. Chromium sums a line's advances once; summed piece by piece every piece's
 * rounding adds up, and a delta line read wider than Chromium set it and took a second line the print does not
 * (`packKpiLayout.test.ts`, the third pack on an edge). `lead` is set before the text on its first line (the delta's
 * arrow cue and its space) and may stand alone on it; `mark` is a footnote mark that stays with the last piece.
 *
 * No guard is kept off the column. Every width here is never short of Chromium's (`textPx`: the exact advance sum
 * rounded up to Chromium's 1/64px unit, and one unit more, because the shaping model is a unit off either way on some
 * strings), and a column is never wider than Chromium's (the frozen figure columns are those same never-short widths):
 * a line the model fits, Chromium fits. A guard would only add lines Chromium does not set.
 */
function lineCount(text: string, widthOf: (line: string) => number, avail: number, lead = 0, mark = 0): number {
  const all = pieces(text);
  let lines = 1;
  let line = '';
  let before = lead;
  all.forEach((piece, i) => {
    const candidate = line === '' ? piece.text : `${line}${piece.spaced ? ' ' : ''}${piece.text}`;
    const w = before + widthOf(candidate) + (i === all.length - 1 ? mark : 0);
    if ((line !== '' || before > 0) && w > avail) { lines += 1; line = piece.text; before = 0; } else line = candidate;
  });
  return lines;
}

const plain = (line: string): number => textPx(line, TEXT_PX, 400);

/** How many lines each wrapped part of a tile takes in a column `columnPx` wide (0 for a part the tile lacks). */
export interface KpiTileLines { label: number; reason: number; delta: number }

export function kpiTileLines(tile: KpiTile, columnPx: number): KpiTileLines {
  return {
    label: lineCount(tile.label, plain, columnPx, 0, labelMarkPx(tile.trendFootnote)),
    reason: tile.figure.value === null ? lineCount(tile.figure.unavailable ?? '', reasonPx, columnPx) : 0,
    // The arrow cue is a run of its own, a space before the words (`</span>{' '}`): a break may follow it.
    delta: tile.delta === null ? 0 : lineCount(deltaText(tile), plain, columnPx, DELTA_CUE_PX + plain(' ')),
  };
}

/** One tile's height in a column `columnPx` wide. */
export function kpiTileMm(tile: KpiTile, columnPx: number): number {
  const lines = kpiTileLines(tile, columnPx);
  const parts = [lines.label * LABEL_LINE_MM, tile.figure.value === null ? lines.reason * REASON_LINE_MM : FIGURE_LINE_MM];
  if (tile.delta !== null) parts.push(lines.delta * LABEL_LINE_MM + DELTA_CUE_MM);
  if (tile.sparklineSvg !== null) {
    parts.push(Math.min(SPARKLINE_MAX_MM, (columnPx / MM_PX) * sparklineAspect(tile.sparklineSvg) + 0.01));
  }
  return parts.reduce((sum, p) => sum + p, 0) + (parts.length - 1) * TILE_GAP_MM;
}

/** The block's height: its rows of four, each as tall as its tallest tile, a gutter apart. */
export function kpiBlockMm(tiles: readonly KpiTile[], scale: MoneyScale, orientation: PageOrientation): number {
  const columns = kpiColumnsPx(tiles, scale, orientation);
  let total = 0;
  for (let i = 0; i < tiles.length; i += 4) {
    total += (i === 0 ? 0 : GUTTER_MM) + Math.max(0, ...tiles.slice(i, i + 4).map((tile, j) => kpiTileMm(tile, columns[j]!)));
  }
  return total;
}
