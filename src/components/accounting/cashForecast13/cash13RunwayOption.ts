/**
 * The 13-week runway chart (cash13 PR 3): closing cash per week as a line in the actual ink, and the weeks whose
 * closing cash is below zero shaded by a bar in the unfavourable ink (`varianceColor(false)`, the one source of
 * red), as P6's runwayOption does for months. No minimum-cash line: the forecast does not carry one. Pure: the
 * palette is an argument; every name reaching the HTML tooltip goes through `escapeHtml`.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { formatStatementFigure } from '@/lib/format/money';
import type { ChartPalette } from '@/components/accounting/charts/chartTypes';
import { escapeHtml } from '@/components/accounting/charts/escapeHtml';
import { roleStyle, varianceColor } from '@/components/accounting/charts/ibcs';
import type { ForecastWeek } from '@/modules/accounting/services/cashForecast13/types';
import { lowestWeek, weekLabel } from './forecastRows';

export const CLOSING_SERIES = 'Closing cash';
export const BELOW_ZERO_SERIES = 'Below zero';

const rands = (c: number): number => c / 100;
const R = (cents: number): string => (cents === 0 ? 'R 0' : formatStatementFigure(cents / 100, { symbol: true }));

interface TooltipParam { seriesName: string; axisValue: string; value: number | null }

/** The chart's figures in words, for a screen reader. */
export function runwaySummary(weeks: readonly ForecastWeek[]): string {
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  const low = lowestWeek(weeks);
  if (!first || !last || !low) return 'No weeks to show.';
  return `Closing cash ${R(first.closingCents)} in week 1 to ${R(last.closingCents)} in week ${last.index + 1}; `
    + `lowest ${R(low.closingCents)} in week ${low.index + 1}.`;
}

export function buildCash13RunwayOption(weeks: readonly ForecastWeek[], palette: ChartPalette): EChartsCoreOption {
  const style = roleStyle('actual', palette);
  const color = style.color === 'transparent' ? style.borderColor ?? palette.ink : style.color;
  const closing = weeks.map((w) => rands(w.closingCents));
  const negative = weeks.map((w) => (w.closingCents < 0 ? rands(w.closingCents) : null));
  const shade = negative.some((v) => v !== null)
    ? [{ name: BELOW_ZERO_SERIES, type: 'bar', data: negative, barWidth: '70%', silent: true, itemStyle: { color: varianceColor(false, palette), opacity: 0.25 } }]
    : [];
  return {
    animation: false,
    grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
    legend: { top: 0, textStyle: { color: palette.axisLabel }, data: [CLOSING_SERIES] },
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
      data: weeks.map(weekLabel),
      axisLabel: { color: palette.axisLabel },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: {
      // No explicit min/max: ECharts picks a round extent (0 included on a value axis that is not `scale`), so the
      // top label is a tick. A padded max (axisDomain) printed "21 600" over "20 000" (browser proof 2026-11-17).
      type: 'value',
      axisLabel: { color: palette.axisLabel, formatter: (v: number) => formatStatementFigure(v) },
      splitLine: { lineStyle: { color: palette.axisLine } },
    },
    series: [
      ...shade,
      { name: CLOSING_SERIES, type: 'line', data: closing, symbolSize: 6, lineStyle: { color, width: 2 }, itemStyle: { color } },
    ],
  };
}
