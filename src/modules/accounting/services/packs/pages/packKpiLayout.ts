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
import { PackRefusal } from '../packRefusal';
import { GUTTER_MM } from './packDisclosureHeight';
import {
  deltaText, kpiColumnMinPx, kpiFit, KPI_GAP_PX, KPI_FIGURE_MAX_PT, labelMarkExactPx, MM_PX, type KpiTile,
} from './packFigureFit';
import { ptToPx, textExactPx, textPx } from './packFigureWidth';
import { AS_CHROMIUM_SETS, CHROMIUM_LEAST, CHROMIUM_MOST, clustersOf, fitUnitsPx, inFace } from './packGlyphRuler';
import { pieces } from './packLineBreaks';
import { reasonExactPx } from './packReasonWidth';
import { PRINT_CONTENT_PX, type PageOrientation } from './packTextMetrics';

/** One CSS pixel, in mm. */
const PX_MM = 25.4 / 96;
/** Chromium lays boxes out in 1/64px units. */
const floor64 = (px: number): number => Math.floor(px * 64 + 1e-6) / 64;
const ceil64 = (px: number): number => Math.ceil(px * 64 - 1e-6) / 64;
/**
 * Leadings, as Chromium sets them in its 1/64px unit (`packKpiLeadings.test.ts` re-measures each): a label or a delta
 * line is 12pt, 16px; a not-meaningful reason line 14pt, 18.667px, set at 18.671875; a figure 25pt, 33.333px, set at
 * 33.328125. The delta's first line is 1px taller: its arrow cue sits in a 7pt run.
 */
export const LABEL_LINE_MM = 16 * PX_MM;
export const REASON_LINE_MM = 18.671875 * PX_MM;
export const FIGURE_LINE_MM = 33.328125 * PX_MM;
export const DELTA_CUE_MM = 1 * PX_MM;
/** `.pack-kpi-tile { gap: 1mm }`, as Chromium sets it: floored to its unit, 3.765625px. */
const TILE_GAP_MM = floor64(MM_PX) * PX_MM;
/** `.pack-kpi-tiles { gap: var(--pack-gutter) }` (8mm) between rows, floored to its unit: 30.234375px. */
const ROW_GAP_MM = floor64(GUTTER_MM * MM_PX) * PX_MM;
/** `.pack-kpi-sparkline svg { max-height: 33mm }`, floored to its unit: 124.71875px. */
const SPARKLINE_MAX_PX = floor64(33 * MM_PX);
const TEXT_PX = 12;

/**
 * The sparkline's height over its width, from the width and height the chart renderer wrote on its root `<svg>`
 * (`renderChartSvg`; `packKpiLayoutModel.test.ts` pins that format). An SVG without them is a renderer this model was
 * not built against: refused, not guessed at.
 */
function sparklineAspect(svg: string): number {
  const w = /<svg[^>]* width="(\d+(?:\.\d+)?)"/.exec(svg);
  const h = /<svg[^>]* height="(\d+(?:\.\d+)?)"/.exec(svg);
  if (w === null || h === null || Number(w[1]) <= 0) {
    throw new PackRefusal(
      'packKpiLayout: a sparkline SVG without a numeric width and height on its root element; its height cannot be sized',
      'A trend line on page 3 could not be sized, so the page cannot be laid out exactly.',
    );
  }
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

/** The grid's `1fr` tracks over the columns' min-content widths `mins`, `gapPx` apart. */
function tracks(mins: readonly number[], gapPx: number, orientation: PageOrientation): { columns: number[]; frozen: boolean[]; share: number } {
  const room = PRINT_CONTENT_PX[orientation] - 3 * gapPx;
  const frozen = mins.map(() => false);
  let share = room / 4;
  for (let again = true; again;) {
    again = false;
    const free = frozen.filter((f) => !f).length;
    share = free === 0 ? 0 : (room - mins.reduce((sum, m, i) => sum + (frozen[i] ? m : 0), 0)) / free;
    mins.forEach((m, i) => { if (!frozen[i] && m > share) { frozen[i] = true; again = true; } });
  }
  return { columns: mins.map((m, i) => (frozen[i] ? m : share)), frozen, share };
}

/**
 * The width of each of the four columns, in pixels, two ways. `line`: the narrowest Chromium can make it, which lines
 * break in, so a line the model fits, Chromium fits: a column a figure or a word holds open at the narrowest Chromium can
 * set that (`CHROMIUM_LEAST`), a shared `1fr` column at the share left once every held-open column is the widest
 * Chromium can set it (`CHROMIUM_MOST`), floored to the unit. `spark`: the widest (each figure a unit off either way and
 * its one unit of slack taken back, the 8mm gaps floored to Chromium's unit), which a sparkline's height follows, so the
 * height is never short either.
 */
export function kpiColumnBoundsPx(tiles: readonly KpiTile[], scale: MoneyScale, orientation: PageOrientation): { line: number[]; spark: number[] } {
  const figurePx = kpiFigurePx(tiles, scale, orientation);
  const mins = kpiColumnMinPx(tiles, scale, figurePx);
  const neverShort = tracks(mins, KPI_GAP_PX, orientation);
  // Lines break in the narrowest each column can be: a column a figure (or a word) holds open at the narrowest Chromium
  // can set that, and a shared `1fr` column at the share left once every held-open column is the widest Chromium can set
  // it, floored to the unit (Chromium's grid sizes tracks in it).
  const most = tracks(kpiColumnMinPx(tiles, scale, figurePx, CHROMIUM_MOST), floor64(KPI_GAP_PX), orientation);
  const least = kpiColumnMinPx(tiles, scale, figurePx, CHROMIUM_LEAST);
  const line = most.columns.map((c, i) => (most.frozen[i] ? least[i]! : floor64(most.share)));
  const wide = tracks(mins.map((m) => m - 2 / 64), floor64(KPI_GAP_PX), orientation);
  return { line, spark: neverShort.columns.map((c, i) => (neverShort.frozen[i] ? c : Math.max(c, wide.columns[i]!))) };
}

/** The width of each of the four columns lines break in, in pixels: the grid's `1fr` tracks over their min-content widths. */
export function kpiColumnsPx(tiles: readonly KpiTile[], scale: MoneyScale, orientation: PageOrientation): number[] {
  return kpiColumnBoundsPx(tiles, scale, orientation).line;
}

/**
 * How many lines Chromium sets `text` in, `avail` px wide: a greedy fill over the places it may break (`pieces`), each
 * candidate line measured as ONE string, the way Chromium's line breaker decides that a piece still fits: every box on
 * the line summed exactly and floored to the 1/64px unit once, with Chromium's noise margin (`packGlyphRuler.fitUnitsPx`;
 * `exactOf`: `textExactPx`, `reasonExactPx`). `lead` is the delta's arrow cue, its own box at the width Chromium sets it,
 * with `leadText` (the space after it) measured with the first line's words; `mark` is a footnote mark's exact sum, which
 * stays with the last piece. A line that ends at a soft hyphen carries the hyphen Chromium sets there (`Piece.hyphen`).
 *
 * No guard is kept off the column, and the column is the narrowest Chromium can make it (`kpiColumnBoundsPx`): a line
 * the model fits, Chromium fits (`packLineFit.test.ts`: the rule is never short on the 630-case grid and the ruler's
 * random strings; `packKpiLayoutGrid.test.ts`: no block short, and none a line over, on the grid's 11,520 packs).
 */
function lineCount(text: string, exactOf: (line: string, hyphen: boolean) => number, avail: number, lead = 0, mark = 0, leadText = ''): number {
  const all = pieces(text);
  let lines = 1;
  let line = '';
  let first = true;
  all.forEach((piece, i) => {
    const candidate = line === '' ? piece.text : `${line}${piece.spaced ? ' ' : ''}${piece.text}`;
    const before = first ? lead : 0;
    const w = fitUnitsPx(before + exactOf(first ? `${leadText}${candidate}` : candidate, piece.hyphen) + (i === all.length - 1 ? mark : 0));
    if ((line !== '' || before > 0) && w > avail) { lines += 1; line = piece.text; first = false; } else line = candidate;
  });
  return lines;
}

const plainExact = (line: string, hyphen = false): number => textExactPx(line, TEXT_PX, 400, hyphen);
/** The delta's arrow cue, its own inline box: at the width Chromium sets it (the exact sum rounded up to the unit). */
const DELTA_CUE_FIT_PX = Math.max(...['\u2191', '\u2193', '\u2192'].map((arrow) => textPx(arrow, ptToPx(7), 400, false, AS_CHROMIUM_SETS)));

/** The texts already found to be set wholly in the pack's own faces. */
const IN_FACE = new Set<string>();

/**
 * A tile's wrapped text must be set in the pack's own faces. A glyph from a fallback face (Thai, Devanagari, Arabic,
 * Tibetan, an emoji) brings that face's taller line box, which this model cannot size: a tile read up to 7.1mm short.
 * The pack is refused rather than under-read. Every string a KPI tile carries is the pack's own wording, so this is a
 * guard for a future one, not a refusal a company meets.
 */
function inPackFaces(text: string): string {
  if (IN_FACE.has(text)) return text;
  // A soft hyphen and a zero-width space are set as nothing, a line or paragraph separator as a space (`runPx`).
  const outside = clustersOf(text.replace(/[\u00AD\u200B]/g, '').replace(/[\u2028\u2029]/g, ' ')).find((cluster) => !inFace(cluster));
  if (outside !== undefined) {
    const code = Array.from(outside, (ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
    throw new PackRefusal(
      `packKpiLayout: the KPI tile text "${text}" holds "${outside}" (${code}), which the pack's faces do not set; its line box cannot be sized`,
      'A highlight on page 3 uses a character the pack\'s typeface does not have, so the page cannot be laid out exactly.',
    );
  }
  if (IN_FACE.size >= 10_000) IN_FACE.clear();
  IN_FACE.add(text);
  return text;
}

/** How many lines each wrapped part of a tile takes in a column `columnPx` wide (0 for a part the tile lacks). */
export interface KpiTileLines { label: number; reason: number; delta: number }

export function kpiTileLines(tile: KpiTile, columnPx: number): KpiTileLines {
  return {
    label: lineCount(inPackFaces(tile.label), plainExact, columnPx, 0, labelMarkExactPx(tile.trendFootnote)),
    reason: tile.figure.value === null ? lineCount(inPackFaces(tile.figure.unavailable ?? ''), reasonExactPx, columnPx) : 0,
    // The arrow cue is a box of its own, then a space and the words (`</span>{' '}`): a break may follow the cue.
    delta: tile.delta === null ? 0 : lineCount(inPackFaces(deltaText(tile)), plainExact, columnPx, DELTA_CUE_FIT_PX, 0, ' '),
  };
}

/** One tile's height in a column `columnPx` wide (its sparkline `sparkPx` wide: `kpiColumnBoundsPx`). */
export function kpiTileMm(tile: KpiTile, columnPx: number, sparkPx: number = columnPx): number {
  const lines = kpiTileLines(tile, columnPx);
  const parts = [lines.label * LABEL_LINE_MM, tile.figure.value === null ? lines.reason * REASON_LINE_MM : FIGURE_LINE_MM];
  if (tile.delta !== null) parts.push(lines.delta * LABEL_LINE_MM + DELTA_CUE_MM);
  if (tile.sparklineSvg !== null) {
    // Chromium floors the sparkline's height (the column's width times its aspect) to its unit; the model takes the unit
    // above, at the widest the column can be.
    parts.push(Math.min(SPARKLINE_MAX_PX, ceil64(sparkPx * sparklineAspect(tile.sparklineSvg))) * PX_MM);
  }
  return parts.reduce((sum, p) => sum + p, 0) + (parts.length - 1) * TILE_GAP_MM;
}

/** The block's height: its rows of four, each as tall as its tallest tile, a gutter apart. */
export function kpiBlockMm(tiles: readonly KpiTile[], scale: MoneyScale, orientation: PageOrientation): number {
  const { line, spark } = kpiColumnBoundsPx(tiles, scale, orientation);
  let total = 0;
  for (let i = 0; i < tiles.length; i += 4) {
    total += (i === 0 ? 0 : ROW_GAP_MM) + Math.max(0, ...tiles.slice(i, i + 4).map((tile, j) => kpiTileMm(tile, line[j]!, spark[j]!)));
  }
  return total;
}
