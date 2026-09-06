/**
 * Profit bridge. ECharts has no waterfall series, and the standard
 * transparent-base-plus-stacked-bar trick breaks the moment a movement or a
 * subtotal crosses zero: ECharts stacks positive and negative values on
 * independent axes, so a step from +400,000 to −400,000 renders as an
 * 800,000 bar sitting entirely above the axis instead of a bar that crosses
 * it, and a loss subtotal renders above the axis instead of below it.
 *
 * A `custom` series sidesteps that: `renderItem` maps `[start, end]` to a
 * rect via `api.coord`, which is correct on either side of zero and across
 * it, because it asks the coordinate system for the pixel position of each
 * endpoint directly instead of asking ECharts to stack signed magnitudes.
 *
 * The number PRINTED on the bar is `step.value`, the service's own signed
 * figure — never the bar's derived height. That separation is the whole
 * reason this builder is allowed to do arithmetic at all.
 *
 * NARROW SCREENS. At 375px a seven-step bridge has about 45px per category.
 * Inline value labels then overlap each other into an unreadable smear, and
 * `hideOverlap` silently drops five of the seven category names — a chart
 * whose bars are unlabelled is not a chart, it is a shape. Below
 * `NARROW_WIDTH` the value labels are dropped in favour of the tooltip (IBCS
 * asks that a figure be legible, not that it be printed on the bar) and the
 * category labels rotate rather than disappear. The value axis still carries
 * the scale, and the unit note above the frame still states it.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type {
  CustomSeriesRenderItem,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
} from 'echarts';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { escapeHtml } from './escapeHtml';
import { axisDomain, roleStyle, varianceColor } from './ibcs';

/** A movement's colour is the variance of the movement itself — favourable
 *  when it grows profit, unfavourable when it shrinks it — never the step's
 *  legacy name hint. A subtotal carries no variance of its own; it stays
 *  actual ink. */
function barColor(step: WaterfallStep, palette: ChartPalette): string {
  if (step.isSubtotal) return roleStyle('actual', palette).color;
  const favourable = step.end - step.start >= 0;
  return varianceColor(favourable, palette) ?? roleStyle('actual', palette).color;
}

/** Below this the bars are too close for an inline figure to sit above one
 *  without colliding with its neighbour. 375px is the narrowest phone the
 *  app supports; a seven-step bridge there is ~45px per category. */
export const NARROW_WIDTH = 520;

export function makeWaterfallRenderItem(
  steps: WaterfallStep[],
  palette: ChartPalette,
  opts: { cents?: boolean } = {},
): CustomSeriesRenderItem {
  return function renderItem(
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ) {
    const step = steps[params.dataIndex];
    if (!step) return undefined;

    // Asked of the live chart, not of a prop: the same option is used at
    // every width, and this is the width it is actually being drawn at.
    const chartWidth = typeof api.getWidth === 'function' ? api.getWidth() : Infinity;
    const showValueLabel = chartWidth >= NARROW_WIDTH;

    const p1 = api.coord([params.dataIndex, step.start]);
    const p2 = api.coord([params.dataIndex, step.end]);
    const [x1 = 0, y1 = 0] = p1;
    const [, y2 = 0] = p2;
    const bandRaw = api.size ? api.size([1, 0]) : undefined;
    const band = (Array.isArray(bandRaw) ? bandRaw[0] : typeof bandRaw === 'number' ? bandRaw : 20) ?? 20;
    const width = band * 0.6;
    const x = x1 - width / 2;
    const y = Math.min(y1, y2);
    const height = Math.abs(y1 - y2);

    const bar = {
      type: 'rect' as const,
      shape: { x, y, width, height },
      style: { fill: barColor(step, palette) },
    };
    if (!showValueLabel) return { type: 'group', children: [bar] };

    return {
      type: 'group',
      children: [
        bar,
        {
          type: 'text',
          style: {
            text: formatMoney(step.value, { cents: opts.cents }),
            x: x + width / 2,
            y: y - 4,
            fill: palette.ink,
            fontFamily: palette.figFont,
            fontSize: 10,
            align: 'center',
            verticalAlign: 'bottom',
          },
        },
      ],
    };
  };
}

export function buildWaterfallOption(
  steps: WaterfallStep[],
  palette: ChartPalette,
  opts: { cents?: boolean } = {},
): EChartsCoreOption {
  return {
    // ECharts applies `media` from the chart's own rendered size, so one
    // option serves every width without the component measuring anything.
    media: [
      {
        query: { maxWidth: NARROW_WIDTH },
        option: {
          grid: { left: 8, right: 8, top: 28, bottom: 56, containLabel: true },
          xAxis: {
            axisLabel: {
              // Every category named, rotated to fit. `hideOverlap` here was
              // dropping five of seven names on a 375px screen.
              interval: 0,
              hideOverlap: false,
              rotate: 45,
              fontSize: 9,
              color: palette.axisLabel,
            },
          },
        },
      },
    ],
    grid: { left: 8, right: 8, top: 28, bottom: 24, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: (p: { dataIndex: number }) => {
        const s = steps[p.dataIndex];
        return s
          ? `${escapeHtml(s.label)}<br/>${formatMoney(s.value, { cents: opts.cents, symbol: true })}`
          : '';
      },
    },
    xAxis: {
      type: 'category',
      data: steps.map((s) => s.label),
      axisLabel: { color: palette.axisLabel, interval: 0, hideOverlap: true },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: {
      type: 'value',
      ...axisDomain(steps.flatMap((s) => [s.start, s.end])),
      axisLabel: { color: palette.axisLabel, formatter: (v: number) => formatMoney(v) },
      splitLine: { lineStyle: { color: palette.axisLine } },
    },
    series: [
      {
        name: 'bar',
        type: 'custom',
        renderItem: makeWaterfallRenderItem(steps, palette, opts),
        clip: true,
        data: steps.map((s) => [s.start, s.end]),
      },
    ],
  };
}
