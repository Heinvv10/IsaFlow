/**
 * ECharts options for the pack's two chart sections. Pure: no DOM, no theme
 * lookup, no data fetching — so the same option object is rendered by the
 * browser on the printed page and by the server-side SVG renderer.
 *
 * The palette is a parameter rather than a `getComputedStyle` call because
 * this module runs in Node (serverChartSvg.ts) as well as in the browser.
 * Defaults mirror the `--ff-*` fallbacks in src/lib/charts/theme.ts.
 *
 * NOTE ON FIGURES: `base` and `visible` below are chart GEOMETRY derived from
 * the service's own `start`, `end` and `value`; no figure is invented and
 * nothing is summed. The number a reader sees on a bar label is `step.value`
 * exactly as the service produced it.
 *
 * SECURITY: ECharts' `tooltip.formatter` renders its return value as HTML.
 * Every label below is ledger-sourced text (an account or step name), so it
 * is escaped before interpolation — see `escapeHtml.ts`.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
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

export const DEFAULT_CHART_PALETTE: ChartPalette = {
  ink: '#15202b',
  fav: '#1f7a4d',
  unfav: '#b23a3a',
  prior: '#c9d0cc',
  axis: '#9ca3af',
};

export interface TrendPoint {
  label: string;
  value: number;
}

function stepColour(step: WaterfallStep, palette: ChartPalette): string {
  if (step.isSubtotal) return palette.ink;
  return step.value < 0 ? palette.unfav : palette.fav;
}

function firstParam(params: TopLevelFormatterParams): TooltipDataParam | undefined {
  return Array.isArray(params) ? params[0] : params;
}

function labelTooltipFormatter(labels: string[], values: number[]) {
  return (params: TopLevelFormatterParams): string => {
    const idx = firstParam(params)?.dataIndex ?? 0;
    const label = labels[idx] ?? '';
    const value = values[idx] ?? 0;
    return `${escapeHtml(label)}: ${value}`;
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
      axisLabel: { color: palette.axis },
      axisLine: { lineStyle: { color: palette.axis } },
      splitLine: { lineStyle: { color: palette.prior } },
    },
    series: [
      {
        name: 'base',
        type: 'bar',
        stack: 'waterfall',
        silent: true,
        itemStyle: { color: 'transparent' },
        data: steps.map((s) => (s.isSubtotal ? 0 : Math.min(s.start, s.end))),
      },
      {
        name: 'movement',
        type: 'bar',
        stack: 'waterfall',
        data: steps.map((s) => ({
          value: Math.abs(s.value),
          itemStyle: { color: stepColour(s, palette) },
        })),
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
