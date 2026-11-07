/**
 * HOW CHROMIUM LAYS OUT A ROW OF KPI TILES, SO THE FIT MODEL KNOWS ITS HEIGHT.
 *
 * `.pack-kpi-tiles` is `repeat(4, 1fr)` over `nowrap` figures, so its columns are the grid algorithm's: a column
 * whose min-content (its figure, its label's longest word, its reason's, its delta's: `kpiColumnMinPx`) is wider
 * than the equal share keeps that width, and the rest share what is left. A tile is a flex column with a 1mm gap:
 * its label, then its figure or its not-meaningful reason, then its delta line, then its sparkline, each as tall as
 * the lines Chromium breaks it into at the column's width. A row is as tall as its tallest tile. The row is as wide
 * as production prints the page (`PRINT_CONTENT_PX`, 658.390625px portrait), not the 174mm (657.6px) of the margins.
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
import { linesFor, runsOf } from './packLineWrap';
import { reasonPx } from './packReasonWidth';
import { PRINT_CONTENT_PX, type PageOrientation } from './packTextMetrics';

/** Leadings, in mm: the label and the delta (12pt), the not-meaningful reason (14pt), the figure (25pt). */
const LABEL_LINE_MM = 4.24;
const REASON_LINE_MM = 4.94;
const FIGURE_LINE_MM = 8.83;
/** The delta's first line is 0.27mm taller than its leading: the arrow cue sits in a 7pt run. */
const DELTA_CUE_MM = 0.27;
/** `.pack-kpi-tile { gap: 1mm }`. */
const TILE_GAP_MM = 1;
/** `.pack-kpi-sparkline svg { max-height: 33mm }`. */
const SPARKLINE_MAX_MM = 33;
const TEXT_PX = 12;
const REASON_SPACE_PX = 3;

/** The sparkline's height over its width, from the width and height the chart renderer wrote on it. */
function sparklineAspect(svg: string): number {
  const w = /<svg[^>]* width="(\d+(?:\.\d+)?)"/.exec(svg);
  const h = /<svg[^>]* height="(\d+(?:\.\d+)?)"/.exec(svg);
  return w === null || h === null ? 0.8 : Number(h[1]) / Number(w[1]);
}

/** The width of each of the four columns, in pixels: the grid's `1fr` tracks over their min-content widths. */
export function kpiColumnsPx(tiles: readonly KpiTile[], scale: MoneyScale, orientation: PageOrientation): number[] {
  const fit = kpiFit(tiles, scale, orientation);
  const mins = kpiColumnMinPx(tiles, scale, fit.px ?? ptToPx(KPI_FIGURE_MAX_PT));
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

/** One tile's height in a column `columnPx` wide. */
export function kpiTileMm(tile: KpiTile, columnPx: number): number {
  const label = linesFor(runsOf(tile.label, (run) => textPx(run, TEXT_PX, 400), textPx(' ', TEXT_PX, 400)),
    labelMarkPx(tile.trendFootnote), columnPx) * LABEL_LINE_MM;
  const reason = tile.figure.unavailable ?? '';
  const figure = tile.figure.value === null
    ? linesFor(runsOf(reason, reasonPx, REASON_SPACE_PX), 0, columnPx) * REASON_LINE_MM
    : FIGURE_LINE_MM;
  const parts = [label, figure];
  if (tile.delta !== null) {
    // The arrow cue is a run of its own, a space before the words (`</span>{' '}`).
    const space = textPx(' ', TEXT_PX, 400);
    const words = runsOf(deltaText(tile), (run) => textPx(run, TEXT_PX, 400), space);
    const first = words[0];
    if (first !== undefined) words[0] = { ...first, gap: space };
    const runs = [{ w: DELTA_CUE_PX, gap: 0 }, ...words];
    parts.push(linesFor(runs, 0, columnPx) * LABEL_LINE_MM + DELTA_CUE_MM);
  }
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
