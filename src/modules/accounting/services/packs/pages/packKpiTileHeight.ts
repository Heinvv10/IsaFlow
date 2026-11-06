/**
 * How tall one KPI tile is — its label, figure, delta line and sparkline.
 * Split out of `packBlockHeights.ts` for the 300-line cap; that file
 * re-exports `kpiTileHeight`, so every caller still imports it there.
 */
import { GUTTER_MM } from './packDisclosureHeight';
import { lines, PAGE_WIDTH_MM, wrappedLines } from './packTextMetrics';
import { deltaWithWord } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import type { PackKpiDelta, PackPageBlock } from './packPageModel';

type KpiTile = (PackPageBlock & { kind: 'kpiTiles' })['tiles'][number];

/** The measure a tile's own text is set across. `repeat(4, 1fr)` with a
 *  `nowrap` figure lets one column pull wider than a quarter and the rest
 *  narrower; 33mm is under every column measured, which is the direction that
 *  over-counts lines rather than under-counting them. */
const KPI_COLUMN_MM = 36;
/** The sparkline is `width: 100%; height: auto` — its height follows its
 *  column, at 0.8 of the width, capped at this by `.pack-kpi-sparkline svg`. */
const KPI_SPARKLINE_MM = 33;
/** What a column the figures have not stretched measures: a quarter of the row less three gutters. */
const QUARTER_MM = (PAGE_WIDTH_MM.portrait - 3 * GUTTER_MM) / 4;
/** The delta line's first line is 17px, not the 16px of its 12pt leading: the arrow cue sits in a 7pt run. */
export const KPI_DELTA_CUE_MM = 0.27;

/**
 * The words a tile's delta line is charged for: THE WORDS THE TILE PRINTS.
 *
 * It was the fixed string "up 00.0%" for every percentage delta. The tile
 * prints its own direction word, and the line is set across a quarter of the
 * measure with no slack — "down 12.0% prior period" takes a second line that
 * "up 00.0% prior period" does not, so a falling figure was under-measured by
 * a whole line. Same call the tile makes (`KpiTileWithSparkline`), with the
 * direction word it derives from the sign, so the model cannot be charging
 * for a different string from the one on the paper.
 */
/**
 * THE MEASURE THE DELTA LINE IS WRAPPED AT, calibrated against the printed
 * sheet rather than taken from `KPI_COLUMN_MM`.
 *
 * At 36mm the model wraps "down 9.9% prior period", which Chromium sets on
 * one line — a line of over-charge that cost the demo sheet a whole
 * disclosure, because page 3 composes within half a millimetre of its box.
 * Twelve delta lines were rendered through the print harness on that sheet:
 * every `up` and `flat` form and a single-digit `down` percentage print on
 * one line; `down 12.0%`, `down 100.0%`, `down 3.0 pp` and `down 12.0 pp`
 * wrap. The model reproduces all twelve between 38.0 and 39.5mm and this is
 * the narrow end of that range, which is the direction that over-counts.
 * `packKpiTileDeltaHeight.test.ts` holds the twelve, and sixteen more from a
 * second render — three-digit points, the grouped four-digit forms. Across the
 * twenty-eight the model never charges less than the paper took, and charges
 * one line more in a single case ("up 100.0 pp").
 */
const KPI_DELTA_MEASURE_MM = 38;

/** The words `KpiTileWithSparkline` prints — the same call, the same nil. */
function deltaWords(delta: PackKpiDelta): string {
  const direction = delta.value > 0 ? 'up' : 'down';
  return deltaWithWord(delta, direction, direction, 'pp', 'flat on');
}

/**
 * One tile's height, in a column `columnMm` wide (a quarter of the row where the figures do not stretch
 * it — see `kpiColumnWidthsMm`). At a quarter every measure is the one this function was calibrated at;
 * a stretched column's sparkline is taller and a squeezed one's delta line wraps sooner.
 */
export function kpiTileHeight(tile: KpiTile, columnMm: number = QUARTER_MM): number {
  // TEXT WRAPS AT THE NARROWER OF THE COLUMN AND A QUARTER, THE SPARKLINE GROWS WITH THE WIDER: the model's
  // figure widths over-read the paper's by about a tenth (`kpiColumnWidthsMm`), so a stretched column is
  // modelled wider than it prints. A wider column wraps less and draws a taller sparkline; charging the
  // text at no more than a quarter and the sparkline at no less than a quarter errs the same way on both
  // (the live demo's real columns are 36.6, 38.9, 38.1 and 36.6mm where the model reads 35.6, 39.3, 39.5, 35.6).
  const textMm = Math.min(columnMm, QUARTER_MM);
  const labelMm = KPI_COLUMN_MM - (QUARTER_MM - textMm);
  const deltaMm = KPI_DELTA_MEASURE_MM - (QUARTER_MM - textMm);
  const label = lines(wrappedLines(tile.label, 9, labelMm), 12);
  const figure = tile.figure.value === null
    ? lines(wrappedLines(tile.figure.unavailable ?? '', 11, labelMm), 14)
    : lines(1, 25);
  // The delta prints as a glyph, its words and its basis — "↑ up 12.4% prior
  // period". See `deltaWords`.
  const delta = tile.delta === null ? 0
    : 1 + KPI_DELTA_CUE_MM + lines(wrappedLines(`X ${deltaWords(tile.delta)} ${tile.delta.basis}`, 9, deltaMm), 12);
  const spark = tile.sparklineSvg === null ? 0 : 1 + Math.min(KPI_SPARKLINE_MM, 0.8 * Math.max(columnMm, QUARTER_MM) + 0.1);
  return label + 1 + figure + delta + spark;
}
