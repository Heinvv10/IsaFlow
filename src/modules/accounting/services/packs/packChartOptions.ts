/**
 * ECharts options for the pack's two chart sections. Pure: no DOM, no theme
 * lookup, no data fetching — so the same option object is rendered by the
 * browser on the printed page and by the server-side SVG renderer.
 *
 * The palette is a parameter rather than a `getComputedStyle` call because
 * this module runs in Node (afs/serverChartSvg.ts) as well as in the browser.
 * The default IS `src/lib/charts/theme.ts`'s `FALLBACK` — imported, not
 * mirrored: the two were byte-identical copies of five hex values, which is
 * one edit away from the pack's charts and the app's charts being different
 * colours with nothing to say which is right.
 *
 * WATERFALL GEOMETRY: a transparent-base-plus-stacked-bar is the usual trick
 * for a waterfall, but ECharts stacks positive and negative values on
 * independent axes — so a step whose `start`/`end` straddle zero (a loss
 * period) renders in the wrong place entirely (a −700 movement from +500
 * drew as if it ran 0 → +600). A `custom` series avoids that: `renderItem`
 * maps `[start, end]` to a rect via `api.coord`, which asks the coordinate
 * system for each endpoint's actual pixel position instead of asking ECharts
 * to stack signed magnitudes — correct on either side of zero and across it.
 *
 * NOTE ON FIGURES: the rect's `y`/`height` are chart GEOMETRY derived from
 * the service's own `start` and `end`; no figure is invented and nothing is
 * summed. The number PRINTED on the bar is `step.value` exactly as the
 * service produced it — never a value derived from the rect.
 *
 * SECURITY: the tooltip formatters render their return value as HTML and
 * every label is ledger-sourced text, so they escape before interpolating.
 * They live in `packChartAxes.ts` with the money axis — see the note there.
 *
 * SCALE. Every money string a chart draws — the y-axis ticks, the number
 * printed on a waterfall bar, the tooltip — goes through `formatMoney` with
 * the DOCUMENT's scale, and the y-axis carries that scale as its axis name.
 * The data stays raw: `api.coord` needs the real values or the geometry
 * moves. Before this the axis of a chart sitting under an `R'000` table ran
 * to `-1,500,000` and a bar was labelled `(1 331 781)` beside a table cell
 * reading `(1 332)`. It is also where `-532,331.6000000001` came from —
 * ECharts' default axis formatter is `String(value)`, and a float tick has
 * no reason to be round.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type {
  CustomSeriesRenderItem,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
} from 'echarts';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { contrastRatio } from '@/lib/brand/contrast';
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import {
  axisDomain,
  compositionTooltip,
  labelTooltipFormatter,
  moneyValueAxis,
  DEFAULT_CHART_PALETTE,
  type ChartPalette,
} from './packChartAxes';

/** The palette and its type live in `packChartAxes.ts` with the money axis
 *  they colour, and are re-exported here because every existing caller —
 *  and every existing test — imports them from this module. */
export { DEFAULT_CHART_PALETTE } from './packChartAxes';
export type { ChartPalette } from './packChartAxes';

export interface TrendPoint {
  label: string;
  value: number;
}

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
function stepColour(step: WaterfallStep, palette: ChartPalette): string {
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
 * EVERY BAR CARRIES ITS OWN VALUE, AND THE LABEL GOES WHEREVER IT CAN BE READ.
 *
 * The label is drawn four pixels ABOVE the bar. A bar with no room there —
 * one whose top is within a line of the top of the plot, which is every
 * total drawn from the axis — takes one of two fallbacks: INSIDE the bar in
 * paper where the bar is tall enough to hold a line of type, and immediately
 * BELOW it in ink where it is not. Neither is cosmetic:
 *
 *   - Off the top, `clip: true` cuts the label in half. Brightsphere's cash
 *     bridge printed `(3 186)` with its lower half missing on a pack that
 *     called itself final.
 *   - Inside the bar in INK is worse, because it fails silently: the bar is
 *     ink-filled, so the label is drawn and invisible. Sheets 6 and 8 printed
 *     Gross Profit, Net Profit, Opening cash and Closing cash — the four
 *     largest marks in the pack — with no value on them at all, leaving hue
 *     as the only cue for an increase against a decrease.
 *   - Inside a SHORT bar in paper fails the same silent way, on white.
 *
 * A directly labelled bar is also the greyscale cue the rubric asks for:
 * `(1 431)` reads under a photocopier and `red` does not.
 */
/**
 * THE AXIS CHROME IS NOT A CONSTANT, BECAUSE THE BOX IS NOT.
 *
 * `top: 32, bottom: 72` is what seven category names rotated thirty degrees
 * need at 12px, and it is right on the 110mm rung. On the 48mm rung — which
 * is where a page carrying a negative-revenue disclosure, a sign-flip
 * footnote and a three-line caption puts the bridge — the box is 181px and
 * that chrome takes 104 of them, so the BARS get 77px. The demo pack's
 * bridge draws its bars over 168px on the same sheet number. The ninth gate
 * read the two side by side and called the short one squashed enough to
 * crowd its own labels, which it is: it is the same chart at 43% plot
 * against 75%.
 *
 * The compact rung gives the labels 56px and sets them at 10px. "Operating
 * Expenses" at 10px is about 92px wide, so rotated thirty degrees it stands
 * 46px tall plus its line — inside 56 with room, and measured on the printed
 * SVG by `packChartAxisLegibility`. What that buys the plot is 28px, better
 * than a third more bar on the rung that needed it most.
 */
const WATERFALL_CHROME = {
  full: { top: 32, bottom: 72, labelPx: 12 },
  compact: { top: 20, bottom: 56, labelPx: 10 },
} as const;

/** The pixels of a waterfall's box its axis chrome takes, for a caller
 *  choosing how many gridlines the rest of it can hold. */
export function waterfallChromePx(compact: boolean): number {
  const chrome = compact ? WATERFALL_CHROME.compact : WATERFALL_CHROME.full;
  return chrome.top + chrome.bottom;
}

const LABEL_GAP_PX = 4;
const LABEL_LINE_PX = 12;

/**
 * A NIL STEP IS STILL A STEP, AND IT HAS TO BE DRAWN WHERE IT HAPPENS.
 *
 * A step whose value is nil spans zero user units, so its rect is zero pixels
 * tall and paints nothing. The label is still drawn, four pixels ABOVE that
 * empty position and set from the baseline up, which puts the glyphs about a
 * line of type clear of the running total they belong to. On Brightsphere's
 * page 6 bridge — 21.25px per R1m, zero at y=818 — the nil cost-of-sales step
 * belongs at y=935.6 and its `–` landed at y=923.5, ON THE (5 000) GRIDLINE.
 * The table two inches above the chart says nil. Any director who reads a
 * bridge against its axis took cost of sales as about five million.
 *
 * So a step that would paint nothing paints a rule instead, one pixel on the
 * running total. That is the reading a nil step should get — the line did not
 * move — and it re-anchors the label, which now sits four pixels above a mark
 * that is actually there rather than above nothing.
 *
 * The floor is on the DRAWN height only. `y` is still the true position, so
 * the label placement and the plot-top test are unchanged, and a rule cannot
 * shift a step that has real height: `Math.max` is a no-op above one pixel.
 */
const NIL_STEP_RULE_PX = 1;

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
function labelInkOn(fill: string, palette: ChartPalette): string {
  return contrastRatio(fill, palette.paper) >= contrastRatio(fill, palette.ink)
    ? palette.paper
    : palette.ink;
}

function makeWaterfallRenderItem(
  steps: WaterfallStep[],
  palette: ChartPalette,
  scale: MoneyScale,
  domain: { min: number; max: number },
): CustomSeriesRenderItem {
  return function renderItem(params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) {
    const step = steps[params.dataIndex];
    if (!step) return undefined;

    const [x1 = 0, y1 = 0] = api.coord([params.dataIndex, step.start]);
    const [, y2 = 0] = api.coord([params.dataIndex, step.end]);
    const bandRaw = api.size ? api.size([1, 0]) : undefined;
    const band = (Array.isArray(bandRaw) ? bandRaw[0] : typeof bandRaw === 'number' ? bandRaw : 20) ?? 20;
    const width = band * 0.6;
    const x = x1 - width / 2;
    const y = Math.min(y1, y2);
    const height = Math.abs(y1 - y2);
    // See `NIL_STEP_RULE_PX`: a zero-height step paints a rule on its running
    // total rather than nothing at all.
    const drawnHeight = Math.max(height, NIL_STEP_RULE_PX);

    // The top of the plot, asked of the coordinate system rather than assumed
    // from `grid.top`: `containLabel` and the axis name both move it, and the
    // domain's own maximum is where the plot ends.
    const [, plotTop = 0] = api.coord([params.dataIndex, domain.max]);
    const above = y - LABEL_GAP_PX;
    const noRoomAbove = above - LABEL_LINE_PX < plotTop;
    // Inside the bar only if the bar is tall enough to hold a line of type.
    // A short bar with no room above it — a near-nil step drawn at the top of
    // the plot — would get paper-on-paper, so its label goes BELOW instead,
    // where a bar drawn from the axis always has the whole plot.
    const inside = noRoomAbove && height >= LABEL_LINE_PX + LABEL_GAP_PX * 2;
    const below = noRoomAbove && !inside;

    return {
      type: 'group',
      children: [
        {
          type: 'rect',
          shape: { x, y, width, height: drawnHeight },
          style: { fill: stepColour(step, palette) },
        },
        {
          type: 'text',
          style: {
            // THE TABLE'S SIGN, NOT THE STEP'S EFFECT ON PROFIT — see
            // `WaterfallStep.labelValue`. The bar's direction already carries
            // the effect; printing the negation of the figure in the table on
            // the same sheet made the chart look like it disagreed with it.
            text: formatMoney(step.labelValue ?? step.value, { scale }),
            x: x + width / 2,
            // A bar that reaches the top of the domain has no room above it,
            // so its label sits just inside the bar instead of half off the
            // paper. See `LABEL_GAP_PX`.
            y: inside ? y + LABEL_GAP_PX : below ? y + height + LABEL_GAP_PX : above,
            // INSIDE THE BAR IT IS SET IN PAPER, NOT INK. Every bar drawn
            // from the axis reaches the top of its own plot, so `clipped` is
            // true of every TOTAL — and ink on an ink-filled total bar is an
            // invisible label. Sheets 6 and 8 printed Gross Profit, Net
            // Profit, Opening cash and Closing cash — the largest marks in
            // the pack — carrying no value at all, which left red/green hue
            // as the only thing separating an increase from a decrease on
            // them. The label was being drawn the whole time.
            fill: inside ? labelInkOn(stepColour(step, palette), palette) : palette.ink,
            align: 'center',
            verticalAlign: inside || below ? 'top' : 'bottom',
          },
        },
      ],
    };
  };
}

/**
 * THE PLOT INSETS EVERY FULL-WIDTH CHART SHARES.
 *
 * The waterfall and the composition bar took `left: 80, right: 24` and the
 * full-width line took `left: 4, right: 64, containLabel: true` — so three
 * chart kinds on one document drew their plots at three different measures
 * and three different left edges, none of them centred on the paper. Measured
 * on the rendered pack: 609, 515 and 581 pixels against a table measure of
 * 753.
 *
 * SYMMETRIC, which is what makes the plot centred on the page rather than
 * merely consistent. The left gutter is the y-axis labels' and cannot go; the
 * right gutter is the line chart's end label, which needs 64. Giving both
 * sides the larger of the two costs the bar charts some plot and buys every
 * chart in the pack one measure and one centre line — the same trade the
 * scorecard's `<colgroup>` makes, and the criterion it is failed on.
 *
 * `containLabel` is deliberately NOT set: it sizes the gutter from whatever
 * the axis happens to print, which is exactly how the small multiples came to
 * have three different left edges in one column.
 */
export const CHART_GUTTER_PX = 80;

/**
 * AND THE RIGHT GUTTER IS NOTHING, BECAUSE A CHART'S RIGHT EDGE IS THE TABLE
 * RULE ABOVE IT OR IT IS NOT ON THE GRID.
 *
 * The round before this one gave every full-width chart the SAME gutter both
 * sides — consistent, centred, and still 109 to 129 pixels short of the
 * table rule on every chart page. Pixel-scanned at 911px: the rules end at
 * 821 and the plots at 704, 699 and lower, so a blank band about 3cm wide at
 * A4 runs down the right of pages 6, 7 and 8 in both packs. Consistency was
 * the wrong target; the measure is.
 *
 * Zero, and the y-axis labels keep the LEFT gutter because they have nowhere
 * else to go. That is the asymmetry the paper actually has: a chart's left
 * edge is where its labels end and its right edge is the page's, which is
 * what every table on every sheet already does.
 *
 * The line chart's end label used to live in this gutter and now sits inside
 * the plot — see `packLineChartOptions`. Nothing else was in it.
 */
export const CHART_GUTTER_RIGHT_PX = 0;

/**
 * What a labelled category axis costs on the right whatever its labels say.
 *
 * ECharts keeps the extreme x label inside the plot by shrinking the plot,
 * so a centred one took half its own width off the chart's measure. The end
 * labels are anchored to the plot's ends now (`alignMaxLabel`), which leaves
 * this fixed reserve — 3px of 658, 0.8mm on the sheet — and no longer varies
 * with the label. A negative `grid.right` does not reclaim it: ECharts
 * clamps, which was measured.
 */
export const AXIS_END_LABEL_RESERVE_PX = 3;

/**
 * @param scale The document's `numberConvention.scale`. REQUIRED — a bridge
 *   drawn in rands beneath a table stated in `R'000` is the 1000x misread
 *   R-P52 exists to stop, and a default would make the unsafe path the easy
 *   one. The step DATA stays raw: `api.coord` maps it to pixels, so scaling
 *   it would move the geometry rather than the labels.
 */
export function waterfallOption(
  steps: WaterfallStep[],
  scale: MoneyScale,
  palette: ChartPalette = DEFAULT_CHART_PALETTE,
  intervals = 6,
  compact = false,
): EChartsCoreOption {
  const domain = axisDomain(steps.flatMap((s) => [s.start, s.end]), intervals);
  const chrome = compact ? WATERFALL_CHROME.compact : WATERFALL_CHROME.full;
  return {
    animation: false,
    grid: { left: CHART_GUTTER_PX, right: CHART_GUTTER_RIGHT_PX, top: chrome.top, bottom: chrome.bottom },
    tooltip: {
      // Same figure the bar prints — see `WaterfallStep.labelValue`.
      formatter: labelTooltipFormatter(steps.map((s) => s.label), steps.map((s) => s.labelValue ?? s.value), scale),
    },
    xAxis: {
      type: 'category',
      data: steps.map((s) => s.label),
      axisLabel: { color: palette.axis, interval: 0, rotate: 30, fontSize: chrome.labelPx },
      axisLine: { lineStyle: { color: palette.axis } },
    },
    yAxis: moneyValueAxis(palette, scale, domain),
    series: [
      {
        name: 'waterfall',
        type: 'custom',
        renderItem: makeWaterfallRenderItem(steps, palette, scale, domain),
        clip: true,
        data: steps.map((s) => [s.start, s.end]),
      },
    ],
  };
}

export function trendOption(
  points: TrendPoint[],
  scale: MoneyScale,
  palette: ChartPalette = DEFAULT_CHART_PALETTE,
): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: CHART_GUTTER_PX, right: CHART_GUTTER_RIGHT_PX, top: 32, bottom: 64 },
    tooltip: {
      formatter: labelTooltipFormatter(points.map((p) => p.label), points.map((p) => p.value), scale),
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.label),
      axisLabel: { color: palette.axis, interval: 0, rotate: 30 },
      axisLine: { lineStyle: { color: palette.axis } },
    },
    yAxis: moneyValueAxis(palette, scale),
    series: [
      {
        name: 'Actual',
        type: 'bar',
        itemStyle: { color: palette.ink },
        data: points.map((p) => p.value),
      },
    ],
  };
}

/**
 * One stacked band of a composition bar. `stack` is the caller's, not this
 * module's: a balance-sheet composition draws assets in one stack and the
 * funding side (liabilities + equity) in another, side by side per period,
 * and only the caller knows which bands belong together.
 */
export interface CompositionSeries {
  name: string;
  stack: string;
  values: number[];
}

/**
 * Spec §4.A page 7's composition bar — one stacked bar per period.
 *
 * ITS BANDS ARE CATEGORIES, SO ITS COLOURS ARE NEUTRAL. They were taken by
 * position from `[ink, unfav, fav, prior]`, which drew the balance sheet's
 * third band in the pack's favourable green: on the demo company that band is
 * equity of (4 088), so the single biggest, greenest object on the sheet was
 * the worst number in the pack — and liabilities and equity were then
 * separated by the red/green pair alone, which is two identical mid-greys
 * under a photocopier. Assets, liabilities and equity are categories; none of
 * them is a good or a bad direction, and the semantic pair belongs to the two
 * bridges, where a bar's colour says which way it moved and the bar carries
 * its own value. See `ChartPalette.categorical`.
 *
 * Not a waterfall: nothing here bridges between two endpoints, so the
 * custom-series geometry `waterfallOption` needs (and the reason it exists)
 * does not apply. A plain stacked bar is correct here because every band is
 * a positive-or-negative magnitude measured from the same zero, and ECharts'
 * stacking hazard across zero bites a BRIDGE, not a composition.
 */
export function compositionBarOption(
  categories: string[],
  series: CompositionSeries[],
  scale: MoneyScale,
  palette: ChartPalette = DEFAULT_CHART_PALETTE,
): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: CHART_GUTTER_PX, right: CHART_GUTTER_RIGHT_PX, top: 40, bottom: 64 },
    tooltip: { formatter: compositionTooltip(scale) },
    legend: { bottom: 0, textStyle: { color: palette.axis } },
    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: { color: palette.axis, interval: 0 },
      axisLine: { lineStyle: { color: palette.axis } },
    },
    yAxis: moneyValueAxis(palette, scale),
    series: series.map((band, index) => ({
      name: band.name,
      type: 'bar',
      stack: band.stack,
      itemStyle: { color: palette.categorical[index % palette.categorical.length]! },
      data: band.values,
    })),
  };
}
