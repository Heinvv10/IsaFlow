/**
 * THE WIDTHS OF A KPI TILE ROW'S FOUR COLUMNS, AS THE PRINT STYLESHEET LAYS THEM OUT.
 *
 * `.pack-kpi-tiles` is `repeat(4, 1fr)` and its figures are `nowrap`, so a column is as wide as its
 * widest figure when that is more than a quarter of the row, and the others share what is left. The
 * figures themselves shrink to fit the row (`font-size: max(12pt, min(22pt, room / --pack-fit-ems))`,
 * `packFigureFit.ts`). This repeats that arithmetic for the height model: a tile's delta line wraps at
 * its column's width and its sparkline is 0.8 of it (capped at 33mm in the stylesheet), so a row of
 * stretched columns is taller than a row of quarters. The model used to charge every tile as if it sat
 * in a quarter and the sparkline at its 33mm cap, which hid a latent shortfall until a stretched column
 * took the slack back.
 *
 * The figure's text is `formatFigureText`'s, the same call the tile makes, at the pack's one scale
 * (as `tableLabelShare` does for the statement tables).
 */
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import { GUTTER_MM } from './packDisclosureHeight';
import type { PackPageBlock } from './packPageModel';
import { PACK_SCALE } from './packScale';
import { kpiFit } from './packFigureFit';
import { PAGE_WIDTH_MM, PT_MM, textWidthEms, type PageOrientation } from './packTextMetrics';

type KpiTile = (PackPageBlock & { kind: 'kpiTiles' })['tiles'][number];

export const KPI_COLUMNS = 4;
/** `.pack-kpi-value`: 22pt, unless the figure fit stamped a smaller size. */
const FIGURE_MAX_PT = 22;

const MM_PX = 96 / 25.4;

/** The widest figure of each of the four columns, in ems, as the row's component states them (`kpiFitStyle`). */
function widestEmsOf(tiles: readonly KpiTile[]): number[] {
  const widestEms = Array.from({ length: KPI_COLUMNS }, () => 0);
  tiles.forEach((tile, i) => {
    if (tile.figure.value === null) return;
    const column = i % KPI_COLUMNS;
    widestEms[column] = Math.max(widestEms[column]!, textWidthEms(formatFigureText(tile.figure, PACK_SCALE)));
  });
  return widestEms;
}

/**
 * The size `.pack-kpi-value` sets a row's figures at, in px: 22pt, or the whole-pixel size the figure fit stamped on
 * the row (`packFigureFit.kpiFit`, `.pack-kpi-tiles.is-fitted`). Nothing in it comes from the content width any more,
 * so the 1/64px a container query reads beyond the line width cannot move it
 * (`tests/unit/print/packKpiFigureSize.test.ts` holds it to Chromium's computed size).
 */
export function kpiFigurePx(tiles: readonly KpiTile[], orientation: PageOrientation = 'portrait'): number {
  return kpiFit(tiles, PACK_SCALE, orientation).px ?? FIGURE_MAX_PT * PT_MM * MM_PX;
}

/** The width of each of the four columns, in millimetres. */
export function kpiColumnWidthsMm(tiles: readonly KpiTile[], orientation: PageOrientation = 'portrait'): number[] {
  const roomMm = PAGE_WIDTH_MM[orientation] - (KPI_COLUMNS - 1) * GUTTER_MM;
  const widestEms = widestEmsOf(tiles);
  const emMm = kpiFigurePx(tiles, orientation) / MM_PX;
  // `minmax(auto, 1fr)`: a column whose figure is wider than the fair share keeps its figure's width,
  // and the rest share what that leaves.
  const base = widestEms.map((ems) => ems * emMm);
  const frozen = base.map(() => false);
  let share = roomMm / KPI_COLUMNS;
  for (let again = true; again;) {
    again = false;
    const free = frozen.filter((f) => !f).length;
    const left = roomMm - base.reduce((sum, b, i) => sum + (frozen[i] ? b : 0), 0);
    share = free === 0 ? 0 : left / free;
    base.forEach((b, i) => {
      if (!frozen[i] && b > share) { frozen[i] = true; again = true; }
    });
  }
  return base.map((b, i) => (frozen[i] ? b : share));
}
