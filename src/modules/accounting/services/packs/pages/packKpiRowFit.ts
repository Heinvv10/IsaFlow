/**
 * THE WIDTHS OF A KPI TILE ROW'S FOUR COLUMNS, WHERE THE FIGURES STRETCH THEM.
 *
 * `.pack-kpi-tiles` is `repeat(4, 1fr)` (`minmax(auto, 1fr)`) and its figures are `nowrap`, so a column is as wide
 * as its widest figure when that is more than a quarter of the row, and the others share what is left. The
 * figures are measured as Chromium lays them out (`packFigureWidth.ts`) at the size `packFigureFit.ts` sets.
 * A tile's delta line wraps at its column's width and its sparkline is 0.8 of it (capped at 33mm in the
 * stylesheet), so a stretched row is taller than a row of quarters.
 *
 * Returns null for a row nothing stretches: the model then charges it as it always has, which is what keeps a
 * pack that fits printing the notes it printed.
 */
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import { KPI_FIGURE_MAX_PT, KPI_GAP_PX, kpiColumnFigurePx, kpiFit } from './packFigureFit';
import { ptToPx } from './packFigureWidth';
import type { PackPageBlock } from './packPageModel';
import { PACK_SCALE } from './packScale';
import { PAGE_WIDTH_MM, type PageOrientation } from './packTextMetrics';

type KpiTile = (PackPageBlock & { kind: 'kpiTiles' })['tiles'][number];

const MM_PX = 96 / 25.4;

/** The width of each of the four columns in millimetres, or null where every column is a quarter. */
export function kpiColumnWidthsMm(tiles: readonly KpiTile[], orientation: PageOrientation = 'portrait'): number[] | null {
  const texts = tiles.map((t) => (t.figure.value === null ? null : formatFigureText(t.figure, PACK_SCALE)));
  const fit = kpiFit(texts, orientation);
  const figurePx = kpiColumnFigurePx(texts, fit.px ?? ptToPx(KPI_FIGURE_MAX_PT));
  const roomPx = PAGE_WIDTH_MM[orientation] * MM_PX - 3 * KPI_GAP_PX;
  const quarter = roomPx / 4;
  if (figurePx.every((px) => px <= quarter)) return null;
  // `minmax(auto, 1fr)`: a column whose figure is wider than the fair share keeps its figure's width, and the
  // rest share what that leaves.
  const frozen = figurePx.map(() => false);
  let share = quarter;
  for (let again = true; again;) {
    again = false;
    const free = frozen.filter((f) => !f).length;
    const left = roomPx - figurePx.reduce((sum, px, i) => sum + (frozen[i] ? px : 0), 0);
    share = free === 0 ? 0 : left / free;
    figurePx.forEach((px, i) => {
      if (!frozen[i] && px > share) { frozen[i] = true; again = true; }
    });
  }
  return figurePx.map((px, i) => (frozen[i] ? px : share) / MM_PX);
}
