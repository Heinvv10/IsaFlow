/**
 * The boxes the pack's charts are drawn in — the one chart measure and spec
 * §5.6's three height rungs. Split out of `packPageCharts.ts` for the
 * 300-line cap: the profit bridge, the cash bridge and the composition chart
 * each take a rung, so the grid is a leaf none of them owns.
 */
import { PAGE_WIDTH_MM } from './packTextMetrics';
import { CHART_HEIGHT_MM } from '@/lib/charts/ssrSvg';

/**
 * THE CHART MEASURE IS THE TABLE MEASURE.
 *
 * Every box here was 170mm against a text measure of 174, so no chart in the
 * pack sat on the grid its own page's tables sit on — a 2mm step down each
 * side, invisible in isolation and plain in a stack. The gate measured the
 * consequence at the plot rather than the box: three different chart measures
 * on one document, none of them the table's, none centred on it.
 *
 * `PAGE_WIDTH_MM.portrait` rather than a literal, so the two cannot drift:
 * the tables take the same constant through `packMattersColumns` and
 * `packScorecardColumns`.
 */
export const CHART_MEASURE_MM = PAGE_WIDTH_MM.portrait;

export const FULL = { widthMm: CHART_MEASURE_MM, heightMm: CHART_HEIGHT_MM.full };

/**
 * Page 8's bridge is the INLINE rung, not half and not full.
 *
 * Its page is the busiest in the pack — a cash table, this bridge, a
 * multi-period cash line and up to two disclosures — and at full height it
 * was 60mm taller than an A4 content box, so it printed on two sheets with
 * the closing-cash chart stranded alone on the second. Half height was still
 * 17mm too tall once the page titles became visible on paper (they had been
 * hidden by a `header` rule in styles/print.css), and on the live demo
 * company, whose cash table carries four footnotes, 35mm too tall. Spec
 * §5.6's height grid is 48/72/110mm and this is the bottom rung — the same
 * rung the closing-cash line beside it already uses, so the two charts on
 * the page are now the same height as each other. Nothing is dropped from
 * the page to buy the space.
 */
export const HALF = { widthMm: CHART_MEASURE_MM, heightMm: CHART_HEIGHT_MM.inline };

/**
 * Spec §5.6's MIDDLE rung, which is what page 7 steps down to.
 *
 * It stepped down to `HALF` — the bottom rung, 48mm — to make room for the
 * negative-assets disclosure, and the callout is right, but at 48mm the
 * composition chart's plot band is about 77px for a 3 000 to (4 000) range
 * and `(1 000)`, `(2 000)` and `(3 000)` printed ON TOP OF ONE ANOTHER.
 * Overlapping axis labels are the visual signature of an unfinished chart,
 * and the room was never needed from the chart: the sheet still ended with
 * ~36mm of white below the last disclosure. 72mm spends 24 of those 36 and
 * leaves the axis 168px to put eight ticks in.
 */
export const MID = { widthMm: CHART_MEASURE_MM, heightMm: CHART_HEIGHT_MM.half };

export type ChartBox = { widthMm: number; heightMm: number };

/** Spec §5.6's height grid, tallest first — the only heights a bridge takes. */
export const BRIDGE_RUNGS: ChartBox[] = [FULL, MID, HALF];

/** How large a bridge is drawn in a box — see `waterfallDrawnSize`. */
export interface DrawnSize { plotPx: number; tallestBarPx: number }

/** The rung a box between rungs grows TOWARD: the lowest one above it. Null
 *  for a box that is itself a rung, or above the top one. */
export function rungAbove(heightMm: number): ChartBox | null {
  if (BRIDGE_RUNGS.some((rung) => rung.heightMm === heightMm)) return null;
  return BRIDGE_RUNGS.filter((rung) => rung.heightMm > heightMm).sort((a, b) => a.heightMm - b.heightMm)[0] ?? null;
}

/**
 * WHETHER A BRIDGE GROWN INTO SPARE PAPER IS TAKEN. A chart that gets taller
 * must never get a smaller picture, and a taller BOX is not a bigger one by
 * itself:
 *
 *  - against the chart the page has: its plot must be taller and its tallest
 *    bar drawn no shorter — a taller box can redraw the axis coarser;
 *  - against the rung above: it must not be drawn larger than that rung is.
 *    The rungs at 72 and 110mm take the full chrome and 12px names; a box
 *    between rungs below the half rung takes the compact one, whose margins
 *    are 28-44px less. Grown far enough, a compact bridge would out-draw the
 *    rung above it, and a page with a millimetre MORE room would get the
 *    smaller picture. So it grows only while it is still the smaller one.
 */
export function isBiggerPicture(grown: DrawnSize, was: DrawnSize, above: DrawnSize | null): boolean {
  if (grown.plotPx <= was.plotPx || grown.tallestBarPx < was.tallestBarPx) return false;
  return above === null || (grown.plotPx < above.plotPx && grown.tallestBarPx <= above.tallestBarPx);
}
