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
 * SECURITY: ECharts' `tooltip.formatter` renders its return value as HTML.
 * Every label below is ledger-sourced text (an account or step name), so it
 * is escaped before interpolation — see `escapeHtml.ts`.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type {
  CustomSeriesRenderItem,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
} from 'echarts';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { formatMoney } from '@/lib/format/money';
import { FALLBACK } from '@/lib/charts/theme';
import { escapeHtml } from './escapeHtml';

/** The shape of an ECharts tooltip-formatter callback param this module
 *  actually reads. Declared locally: `echarts/core` does not export its
 *  internal `CallbackDataParams` / `TopLevelFormatterParams` types. */
interface TooltipDataParam {
  dataIndex: number;
}
type TopLevelFormatterParams = TooltipDataParam | TooltipDataParam[];

export interface ChartPalette {
  ink: string;
  fav: string;
  unfav: string;
  prior: string;
  axis: string;
}

/** `axis` is the theme's `textTertiary`: the axis labels and ticks are the
 *  same grey as tertiary text everywhere else in the app. The other four map
 *  one-to-one. */
export const DEFAULT_CHART_PALETTE: ChartPalette = {
  ink: FALLBACK.ink,
  fav: FALLBACK.fav,
  unfav: FALLBACK.unfav,
  prior: FALLBACK.prior,
  axis: FALLBACK.textTertiary,
};

export interface TrendPoint {
  label: string;
  value: number;
}

/** A movement's colour is the direction of the movement itself — favourable
 *  when it grows the running total, unfavourable when it shrinks it — never
 *  the legacy `color` hint on the step. A subtotal carries no variance of
 *  its own and stays actual ink regardless of whether it is a profit or a
 *  loss. */
function stepColour(step: WaterfallStep, palette: ChartPalette): string {
  if (step.isSubtotal) return palette.ink;
  return step.end - step.start >= 0 ? palette.fav : palette.unfav;
}

function axisDomain(values: number[]): { min: number; max: number } {
  return { min: Math.min(0, ...values), max: Math.max(0, ...values) };
}

function makeWaterfallRenderItem(steps: WaterfallStep[], palette: ChartPalette): CustomSeriesRenderItem {
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

    return {
      type: 'group',
      children: [
        {
          type: 'rect',
          shape: { x, y, width, height },
          style: { fill: stepColour(step, palette) },
        },
        {
          type: 'text',
          style: {
            text: formatMoney(step.value),
            x: x + width / 2,
            y: y - 4,
            fill: palette.ink,
            align: 'center',
            verticalAlign: 'bottom',
          },
        },
      ],
    };
  };
}

function firstParam(params: TopLevelFormatterParams): TooltipDataParam | undefined {
  return Array.isArray(params) ? params[0] : params;
}

/** The tooltip printed the raw number — `1234567.89` where the bar's own
 *  label, the statement three centimetres away and the deck all said
 *  "1 234 568". Same figure, three renderings, and the one a reader hovers to
 *  CHECK a number was the odd one out. `formatMoney` is the app's single
 *  money formatting rule; a negative comes back in parentheses like every
 *  other statement figure. */
function labelTooltipFormatter(labels: string[], values: number[]) {
  return (params: TopLevelFormatterParams): string => {
    const idx = firstParam(params)?.dataIndex ?? 0;
    const label = labels[idx] ?? '';
    const value = values[idx] ?? 0;
    return `${escapeHtml(label)}: ${formatMoney(value)}`;
  };
}

export function waterfallOption(steps: WaterfallStep[], palette: ChartPalette = DEFAULT_CHART_PALETTE): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 80, right: 24, top: 24, bottom: 72 },
    tooltip: {
      formatter: labelTooltipFormatter(steps.map((s) => s.label), steps.map((s) => s.value)),
    },
    xAxis: {
      type: 'category',
      data: steps.map((s) => s.label),
      axisLabel: { color: palette.axis, interval: 0, rotate: 30 },
      axisLine: { lineStyle: { color: palette.axis } },
    },
    yAxis: {
      type: 'value',
      ...axisDomain(steps.flatMap((s) => [s.start, s.end])),
      axisLabel: { color: palette.axis },
      axisLine: { lineStyle: { color: palette.axis } },
      splitLine: { lineStyle: { color: palette.prior } },
    },
    series: [
      {
        name: 'waterfall',
        type: 'custom',
        renderItem: makeWaterfallRenderItem(steps, palette),
        clip: true,
        data: steps.map((s) => [s.start, s.end]),
      },
    ],
  };
}

export function trendOption(points: TrendPoint[], palette: ChartPalette = DEFAULT_CHART_PALETTE): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 80, right: 24, top: 24, bottom: 64 },
    tooltip: {
      formatter: labelTooltipFormatter(points.map((p) => p.label), points.map((p) => p.value)),
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.label),
      axisLabel: { color: palette.axis, interval: 0, rotate: 30 },
      axisLine: { lineStyle: { color: palette.axis } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: palette.axis },
      axisLine: { lineStyle: { color: palette.axis } },
      splitLine: { lineStyle: { color: palette.prior } },
    },
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
