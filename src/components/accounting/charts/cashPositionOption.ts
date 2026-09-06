/**
 * Cash, receivables, payables and net working capital, side by side.
 * One ink for every bar: these are four measures of the same position, and
 * colouring one of them differently would claim a distinction the figures
 * do not make.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { escapeHtml } from './escapeHtml';
import { axisDomain, roleStyle } from './ibcs';

export interface CashPositionPoint {
  name: string;
  value: number;
}

export function buildCashPositionOption(
  points: CashPositionPoint[],
  palette: ChartPalette,
): EChartsCoreOption {
  const actual = roleStyle('actual', palette);
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
        data: points.map((p) => p.value),
        itemStyle: { color: actual.color },
        barMaxWidth: 48,
      },
    ],
  };
}
