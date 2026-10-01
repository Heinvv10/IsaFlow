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
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import {
  axisDomain,
  compositionTooltip,
  labelTooltipFormatter,
  moneyValueAxis,
  DEFAULT_CHART_PALETTE,
  type ChartPalette,
} from './packChartAxes';
import { CHART_GUTTER_PX, CHART_GUTTER_RIGHT_PX } from './packChartGutters';
import { makeWaterfallRenderItem } from './packWaterfallBars';
import { packTextMeasure, WATERFALL_CHROME, type TextMeasure } from './packWaterfallDomain';
import { frameOf } from './packWaterfallFrame';

export { labelInkOn, stepPaint } from './packWaterfallPaint';
export { AXIS_END_LABEL_RESERVE_PX, CHART_GUTTER_PX, CHART_GUTTER_RIGHT_PX } from './packChartGutters';

/** The palette and its type live in `packChartAxes.ts` with the money axis
 *  they colour, and are re-exported here because every existing caller —
 *  and every existing test — imports them from this module. */
export { DEFAULT_CHART_PALETTE } from './packChartAxes';
export type { ChartPalette } from './packChartAxes';

export interface TrendPoint {
  label: string;
  value: number;
}

/** The size a value axis sets its ticks and its name at. */
const TICK_PX = 12;
/** ECharts' own gap between a value axis's end and its name. */
const AXIS_NAME_GAP_PX = 15;

/** The rungs' chrome lives with the layout that sizes the plot from it —
 *  see `packWaterfallDomain.ts`. */
/** The pixels of a waterfall's box its axis chrome takes, for a caller
 *  choosing how many gridlines the rest of it can hold. */
export function waterfallChromePx(compact: boolean): number {
  const chrome = compact ? WATERFALL_CHROME.compact : WATERFALL_CHROME.full;
  return chrome.top + chrome.bottom;
}

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
  /** Called once per bar the floor above actually grew — see
   *  `NIL_STEP_RULE_PX`. The caller carries the labels onto the chart spec so
   *  the sheet can declare the rule; a bar may be reported more than once,
   *  because ECharts may call `renderItem` more than once per datum. */
  onFloored?: (label: string) => void,
  /** The SVG box in pixels. Given, the plot rectangle is exact and the axis
   *  is chosen to give every figure room — see `waterfallLayout`. A bare
   *  number is the height alone, for a chart drawn at whatever width its
   *  container has: no bar's width is known, so every figure gets room
   *  outside its bar. */
  box?: number | { heightPx: number; widthPx: number },
  /** The face the chart's text is drawn in — see `TextMeasure`. */
  measure: TextMeasure = packTextMeasure,
): EChartsCoreOption {
  const chrome = compact ? WATERFALL_CHROME.compact : WATERFALL_CHROME.full;
  const boxPx = typeof box === 'number' ? box : box?.heightPx;
  const frame = frameOf(steps, scale, intervals, compact, box, measure);
  const domain = frame.domain;
  // NOTHING MAY MOVE THE PLOT where the box is known: the rectangle the
  // domain was chosen for is the one drawn, in either face. A bare height in
  // another face (a caller that measures with something else) is
  // the one case left to ECharts, which narrows the plot from the left for
  // wide ticks; its HEIGHT is still held.
  const exact = typeof box === 'object' || measure === packTextMeasure;
  return {
    animation: false,
    grid: {
      left: frame.left, right: CHART_GUTTER_RIGHT_PX, top: frame.top, bottom: frame.bottom,
      ...(boxPx === undefined ? {} : exact ? { outerBoundsMode: 'none' as const } : { outerBoundsClampHeight: '100%' }),
    },
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
    // THE AXIS NAME STAYS ON THE CHART. ECharts sets it 15px clear of the
    // axis, which on the compact rung's 20px of head centred `R'000` a pixel
    // above the SVG — the unit the chart is stated in, cut in half.
    yAxis: { ...moneyValueAxis(palette, scale, domain), nameGap: Math.min(AXIS_NAME_GAP_PX, frame.top - TICK_PX - 1) },
    series: [
      {
        name: 'waterfall',
        type: 'custom',
        renderItem: makeWaterfallRenderItem(steps, palette, scale, domain, onFloored, frame.fontPx),
        clip: true,
        data: steps.map((s) => [s.start, s.end]),
      },
    ],
  };
}

/**
 * A money axis that prints no figure on two ticks. Left to ECharts, a year of
 * nil revenue drew 0 to 1 in fifths and printed "– | <1 | <1 | 1 | 1 | 1".
 * The step is coarsened until every tick is a figure of its own; an axis
 * with nothing on it prints its zero alone.
 */
function distinctTicksAxis(values: number[], palette: ChartPalette, scale: MoneyScale) {
  if (values.every((v) => v === 0)) {
    const axis = moneyValueAxis(palette, scale, { min: 0, max: 1, splitNumber: 1, interval: 1 });
    return { ...axis, axisLabel: { ...axis.axisLabel, showMaxLabel: false } };
  }
  let domain = axisDomain(values, 6);
  for (let ask = 6; ask >= 1; ask -= 1) {
    domain = axisDomain(values, ask);
    const printed = Array.from({ length: domain.splitNumber + 1 }, (_, i) => formatMoney(domain.min + (i * (domain.max - domain.min)) / domain.splitNumber, { scale }));
    if (new Set(printed).size === printed.length) break;
  }
  return moneyValueAxis(palette, scale, { ...domain, interval: (domain.max - domain.min) / domain.splitNumber });
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
    yAxis: distinctTicksAxis(points.map((p) => p.value), palette, scale),
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
/** The pixels of a composition chart's box its axis chrome takes — the
 *  grid's top and bottom — for a caller choosing how many ticks fit. */
export const COMPOSITION_CHROME_PX = { top: 40, bottom: 64 } as const;

/**
 * Where each category's stacks reach, either side of zero. ECharts stacks
 * same-signed bands together, so a stack's top is the sum of its positive
 * bands and its bottom the sum of its negative ones.
 */
function stackExtremes(categories: string[], series: CompositionSeries[]): number[] {
  const stacks = [...new Set(series.map((band) => band.stack))];
  return categories.flatMap((_category, i) => stacks.flatMap((stack) => {
    const values = series.filter((band) => band.stack === stack).map((band) => band.values[i] ?? 0);
    return [
      values.filter((v) => v > 0).reduce((sum, v) => sum + v, 0),
      values.filter((v) => v < 0).reduce((sum, v) => sum + v, 0),
    ];
  }));
}

/**
 * @param intervals How many gridline steps the plot has ROOM for — see
 *   `axisDomain`. Left to ECharts where the caller does not say, which is how
 *   page 7 printed ten tick labels 13px apart on the chart it had shortened.
 */
export function compositionBarOption(
  categories: string[],
  series: CompositionSeries[],
  scale: MoneyScale,
  palette: ChartPalette = DEFAULT_CHART_PALETTE,
  intervals?: number,
): EChartsCoreOption {
  const domain = intervals === undefined
    ? undefined
    : axisDomain(stackExtremes(categories, series), intervals);
  return {
    animation: false,
    grid: { left: CHART_GUTTER_PX, right: CHART_GUTTER_RIGHT_PX, ...COMPOSITION_CHROME_PX },
    tooltip: { formatter: compositionTooltip(scale) },
    legend: { bottom: 0, textStyle: { color: palette.axis } },
    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: { color: palette.axis, interval: 0 },
      axisLine: { lineStyle: { color: palette.axis } },
    },
    yAxis: moneyValueAxis(palette, scale, domain),
    series: series.map((band, index) => ({
      name: band.name,
      type: 'bar',
      stack: band.stack,
      itemStyle: { color: palette.categorical[index % palette.categorical.length]! },
      data: band.values,
    })),
  };
}
