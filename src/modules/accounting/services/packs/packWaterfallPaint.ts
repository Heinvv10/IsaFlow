/**
 * Which ink a waterfall bar is filled with, and which ink a label set inside
 * that bar takes. Moved out of `packChartOptions.ts` unchanged to keep that
 * file under the 300-line cap; `packChartOptions.ts` re-exports `stepPaint`
 * and `labelInkOn`, so existing import paths still resolve.
 */
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { contrastRatio } from '@/lib/brand/contrast';
import type { ChartPalette } from './packChartAxes';

/**
 * A MOVEMENT'S COLOUR IS ITS LINE CLASS, NOT THE ARITHMETIC SIGN OF THE
 * PERIOD — because a colour that changes meaning between two companies is
 * not carrying meaning at all.
 *
 * It was the direction the step moved the running total: favourable when it
 * grew, unfavourable when it shrank. That reads correctly on a company in
 * profit and inverts on one in loss. Brightsphere's income statement drew
 * OPERATING EXPENSES OF 3 717 IN GREEN and REVENUE OF (5 535) IN RED, on the
 * same rubric that draws cost of sales red and revenue green in the demo
 * pack: the same line class, opposite colours, deciding by which way the
 * books happened to run. The mechanism was right — negative expenses do
 * increase profit — and the footnote explained it, and a director scanning
 * the sheet still sees green expenses.
 *
 * So the colour comes off the step's `color` hint, which `buildProfitWaterfall`
 * assigns by CLASS: green on revenue and other income, red on cost of sales
 * and every expense band. Green is an income line and red is a cost line in
 * every pack this platform prints. On the cash bridge the class IS the
 * direction — an inflow is cash in — and the same hint carries it.
 *
 * WHICH WAY THE LINE MOVED IS STILL ON THE PAGE, and more precisely than a
 * hue: every bar carries its own value in the pack's bracket convention, and
 * `(1 431)` says "this took 1 431 off profit" in a way that survives a
 * photocopier. A subtotal carries no class of its own and stays actual ink.
 */
export function stepColour(step: WaterfallStep, palette: ChartPalette): string {
  if (step.isSubtotal) return palette.ink;
  return stepPaint(step) === 'favourable' ? palette.fav : palette.unfav;
}

/**
 * The classification above, WITHOUT the palette — so the bar model carried
 * beside the drawing and the drawing itself cannot disagree about which ink
 * a line got. `toBars` puts it on `PackWaterfallBar.paint` and page 6's
 * footnote reads it back; there is no second copy of the rule anywhere.
 */
export function stepPaint(step: WaterfallStep): 'favourable' | 'unfavourable' | null {
  if (step.isSubtotal) return null;
  return step.color === 'green' || step.color === 'teal' || step.color === 'blue'
    ? 'favourable'
    : 'unfavourable';
}

/**
 * WHICH INK A LABEL DRAWN INSIDE A BAR IS SET IN — decided by contrast
 * against the fill, not assumed.
 *
 * It was always `palette.paper`, which was true of every fill the palette
 * carried at the time. Separating income from cost by lightness (see
 * `DEFAULT_CHART_PALETTE`) made income light enough that white on it is
 * 3.4:1 — under the 4.5:1 a line of 12px type needs — so the assumption
 * would have traded one silent illegibility for another. Paper where paper
 * reads, ink where ink does.
 */
/**
 * EXPORTED so `packInkContrast.test.ts` can hold the pair it produces to the
 * same 4.5:1 floor every other ink in this pack is held to. That file checked
 * every ink the pack sets type in EXCEPT this one — a label set INSIDE a bar,
 * where the background is the bar's fill and not the paper — which is exactly
 * the reading the thirty-first visual gate came back on.
 */
export function labelInkOn(fill: string, palette: ChartPalette): string {
  return contrastRatio(fill, palette.paper) >= contrastRatio(fill, palette.ink)
    ? palette.paper
    : palette.ink;
}
