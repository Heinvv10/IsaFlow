/**
 * The runway chart (budgets P6 spec §8, §13.15): closing cash per month as a line, the minimum-cash threshold
 * as a dashed line, and the months whose closing cash is below zero shaded by a bar in the unfavourable ink
 * (`varianceColor(false)`, the one source of red). Compare overlays up to MAX_RUNWAY_SERIES versions, each in
 * its IBCS role ink (actual, prior, plan). `CashPositionChart` draws four category bars and cannot do this.
 * Pure: the palette is an argument. Every name reaching the HTML tooltip goes through `escapeHtml`.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { formatStatementFigure } from '@/lib/format/money';
import type { ChartPalette } from '@/components/accounting/charts/chartTypes';
import { escapeHtml } from '@/components/accounting/charts/escapeHtml';
import { axisDomain, roleStyle, varianceColor, type SeriesRole } from '@/components/accounting/charts/ibcs';

export const MAX_RUNWAY_SERIES = 3;
export const MIN_CASH_SERIES = 'Minimum cash';
export const BELOW_ZERO_SERIES = 'Below zero';
const ROLES: readonly SeriesRole[] = ['actual', 'prior', 'budget'];

export interface RunwaySeries {
  name: string;
  /** Closing cash per month, cents, aligned with `months`. */
  cents: readonly number[];
}

export interface RunwayInput {
  months: readonly string[];
  series: readonly RunwaySeries[];
  minimumCashCents: number;
}

const rands = (c: number): number => c / 100;

interface TooltipParam { seriesName: string; axisValue: string; value: number | null }

export function buildRunwayOption(input: RunwayInput, palette: ChartPalette): EChartsCoreOption {
  const shown = input.series.slice(0, MAX_RUNWAY_SERIES);
  const lines = shown.map((s, i) => {
    const style = roleStyle(ROLES[i] ?? 'actual', palette);
    // The plan role is an outline (transparent fill): a line takes its border ink.
    const color = style.color === 'transparent' ? style.borderColor ?? palette.ink : style.color;
    return {
      name: s.name,
      type: 'line',
      data: s.cents.map(rands),
      symbolSize: 6,
      lineStyle: { color, width: 2, type: i === 2 ? 'dashed' : 'solid' },
      itemStyle: { color },
    };
  });
  const first = shown[0];
  const negative = first ? first.cents.map((c) => (c < 0 ? rands(c) : null)) : [];
  const shade = negative.some((v) => v !== null)
    ? [{
      name: BELOW_ZERO_SERIES, type: 'bar', data: negative, barWidth: '70%', silent: true,
      itemStyle: { color: varianceColor(false, palette), opacity: 0.25 },
    }]
    : [];
  const min = {
    name: MIN_CASH_SERIES,
    type: 'line',
    data: input.months.map(() => rands(input.minimumCashCents)),
    symbol: 'none',
    lineStyle: { color: palette.plan, width: 1, type: 'dashed' },
    itemStyle: { color: palette.plan },
  };
  const all = [...shown.flatMap((s) => s.cents), input.minimumCashCents].map(rands);
  return {
    // No draw-in animation: the figures are the point, and a half-drawn line reads as a short year.
    animation: false,
    grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
    legend: { top: 0, textStyle: { color: palette.axisLabel }, data: [...shown.map((s) => s.name), MIN_CASH_SERIES] },
    tooltip: {
      trigger: 'axis',
      formatter: (params: TooltipParam[]) => {
        const rows = params.filter((p) => p.seriesName !== BELOW_ZERO_SERIES && p.value !== null);
        const head = escapeHtml(params[0]?.axisValue ?? '');
        return [head, ...rows.map((p) => `${escapeHtml(p.seriesName)}: ${formatStatementFigure(p.value as number, { symbol: true })}`)].join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: [...input.months],
      axisLabel: { color: palette.axisLabel },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: {
      type: 'value',
      ...axisDomain(all),
      axisLabel: { color: palette.axisLabel, formatter: (v: number) => formatStatementFigure(v) },
      splitLine: { lineStyle: { color: palette.axisLine } },
    },
    series: [...shade, ...lines, min],
  };
}
