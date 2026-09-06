/**
 * Cash, receivables, payables and net working capital, side by side.
 *
 * Colour carries ONE fact here: whether the figure is below zero. An
 * overdrawn bank balance and negative working capital are the two readings
 * on this chart a reader must not miss, and drawn in the same ink as a
 * healthy one they were invisible — the bar simply pointed down.
 *
 * A non-negative bar stays actual ink; it is NOT painted favourable. These
 * are four different measures, not four variances: a large payables balance
 * is a normal liability, and green on it would claim good news the figure
 * does not carry. Only `varianceColor` issues red, as everywhere else.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { escapeHtml } from './escapeHtml';
import { axisDomain, roleStyle, varianceColor } from './ibcs';

export interface CashPositionPoint {
  name: string;
  value: number;
}

export function buildCashPositionOption(
  points: CashPositionPoint[],
  palette: ChartPalette,
): EChartsCoreOption {
  const actual = roleStyle('actual', palette);
  // `varianceColor(false)` is the one source of unfavourable ink in the app.
  const belowZero = varianceColor(false, palette) ?? actual.color;
  const inkFor = (value: number) => (value < 0 ? belowZero : actual.color);
  return {
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: Array<{ name: string; value: number }>) =>
        params.map((p) => `${escapeHtml(p.name)}<br/>${formatMoney(p.value, { symbol: true })}`).join('<br/>'),
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.name),
      axisLabel: { color: palette.axisLabel },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: {
      type: 'value',
      ...axisDomain(points.map((p) => p.value)),
      axisLabel: { color: palette.axisLabel, formatter: (v: number) => formatMoney(v) },
      splitLine: { lineStyle: { color: palette.axisLine } },
    },
    series: [
      {
        type: 'bar',
        data: points.map((p) => ({ value: p.value, itemStyle: { color: inkFor(p.value) } })),
        barMaxWidth: 48,
      },
    ],
  };
}
