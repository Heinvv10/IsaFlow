/**
 * How tall one KPI tile is — its label, figure, delta line and sparkline.
 * Split out of `packBlockHeights.ts` for the 300-line cap; that file
 * re-exports `kpiTileHeight`, so every caller still imports it there.
 */
import { lines, wrappedLines } from './packTextMetrics';
import { deltaWithWord } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import type { PackKpiDelta, PackPageBlock } from './packPageModel';

type KpiTile = (PackPageBlock & { kind: 'kpiTiles' })['tiles'][number];

/** The measure a tile's own text is set across. `repeat(4, 1fr)` with a
 *  `nowrap` figure lets one column pull wider than a quarter and the rest
 *  narrower; 33mm is under every column measured, which is the direction that
 *  over-counts lines rather than under-counting them. */
const KPI_COLUMN_MM = 36;
/** The sparkline is `width: 100%; height: auto` — its height follows its
 *  column, at 0.8 of the width across every column the fixtures produce. */
const KPI_SPARKLINE_MM = 33;

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

export function kpiTileHeight(tile: KpiTile): number {
  const label = lines(wrappedLines(tile.label, 9, KPI_COLUMN_MM), 12);
  const figure = tile.figure.value === null
    ? lines(wrappedLines(tile.figure.unavailable ?? '', 11, KPI_COLUMN_MM), 14)
    : lines(1, 25);
  // The delta prints as a glyph, its words and its basis — "↑ up 12.4% prior
  // period". See `deltaWords`.
  const delta = tile.delta === null ? 0
    : 1 + lines(wrappedLines(`X ${deltaWords(tile.delta)} ${tile.delta.basis}`, 9, KPI_DELTA_MEASURE_MM), 12);
  const spark = tile.sparklineSvg === null ? 0 : 1 + KPI_SPARKLINE_MM;
  return label + 1 + figure + delta + spark;
}
