/**
 * Twelve months, one small panel per account, all on ONE scale.
 *
 * The shared scale is the point. Per-panel autoscaling makes a R12k rent
 * line and a R1.8m sales line look like the same business, which is the
 * single most common way a small-multiples grid lies.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { formatMoney } from '@/lib/format/money';
import { escapeHtml, type ChartPalette } from './chartTypes';
import { axisDomain, roleStyle } from './ibcs';

export interface TrendPanel {
  key: string;
  label: string;
  values: number[];
}

const ROW_HEIGHT_PCT = 34;

export function buildSmallMultiplesOption(
  panels: TrendPanel[],
  months: string[],
  palette: ChartPalette,
  opts: { columns?: number } = {},
): EChartsCoreOption {
  const columns = opts.columns ?? 3;
  const scale = axisDomain(panels.flatMap((p) => p.values));
  const actual = roleStyle('actual', palette);

  const grid = panels.map((_, i) => ({
    left: `${(i % columns) * (100 / columns) + 4}%`,
    top: `${Math.floor(i / columns) * (ROW_HEIGHT_PCT + 6) + 8}%`,
    width: `${100 / columns - 8}%`,
    height: `${ROW_HEIGHT_PCT}%`,
    containLabel: false,
  }));

  return {
    title: panels.map((p, i) => ({
      text: p.label,
      left: grid[i]!.left,
      top: `${Math.floor(i / columns) * (ROW_HEIGHT_PCT + 6) + 2}%`,
      textStyle: { fontSize: 11, color: palette.axisLabel, fontWeight: 'normal' as const },
    })),
    tooltip: {
      trigger: 'axis',
      formatter: (params: Array<{ name: string; value: number; seriesName: string }>) =>
        params
          .map((p) => `${escapeHtml(p.seriesName)} ${escapeHtml(p.name)}<br/>${formatMoney(p.value, { symbol: true })}`)
          .join('<br/>'),
    },
    xAxis: panels.map((_, i) => ({
      type: 'category' as const,
      gridIndex: i,
      data: months,
      axisLabel: { show: false },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.axisLine } },
    })),
    yAxis: panels.map((_, i) => ({
      type: 'value' as const,
      gridIndex: i,
      min: scale.min,
      max: scale.max,
      axisLabel: { show: false },
      axisLine: { show: false },
      splitLine: { show: false },
    })),
    grid,
    series: panels.map((p, i) => ({
      name: p.label,
      type: 'line' as const,
      xAxisIndex: i,
      yAxisIndex: i,
      data: p.values,
      showSymbol: false,
      lineStyle: { color: actual.color, width: 1.5 },
      areaStyle: { color: actual.color, opacity: 0.08 },
    })),
  };
}
