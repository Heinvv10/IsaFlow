/**
 * Profit bridge. ECharts has no waterfall series, so the standard shape is
 * used: a transparent placeholder bar stacked under a visible one.
 *
 * The placeholder height is GEOMETRY (`min(start, end)`) and the bar height
 * is `|end − start|`; the number PRINTED on the bar is `step.value`, which is
 * the service's own signed figure. That separation is the whole reason this
 * builder is allowed to do arithmetic at all.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { axisDomain, roleStyle } from './ibcs';

const STACK = 'bridge';

export function buildWaterfallOption(
  steps: WaterfallStep[],
  palette: ChartPalette,
  opts: { cents?: boolean } = {},
): EChartsCoreOption {
  const actual = roleStyle('actual', palette);
  const bars = steps.map((s) => ({
    value: Math.abs(s.end - s.start),
    figure: s.value,
    itemStyle: s.isSubtotal
      ? { color: actual.color, borderColor: actual.color, borderWidth: 0 }
      : { color: actual.color, opacity: 0.72 },
  }));

  return {
    grid: { left: 8, right: 8, top: 28, bottom: 24, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: (p: { dataIndex: number }) => {
        const s = steps[p.dataIndex];
        return s ? `${s.label}<br/>${formatMoney(s.value, { cents: opts.cents, symbol: true })}` : '';
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
        name: 'placeholder',
        type: 'bar',
        stack: STACK,
        silent: true,
        itemStyle: { color: 'transparent' },
        emphasis: { itemStyle: { color: 'transparent' } },
        data: steps.map((s) => Math.min(s.start, s.end)),
      },
      {
        name: 'bar',
        type: 'bar',
        stack: STACK,
        data: bars,
        label: {
          show: true,
          position: 'top',
          color: palette.ink,
          fontFamily: palette.figFont,
          fontSize: 10,
          formatter: (p: { data: { figure: number } }) =>
            formatMoney(p.data.figure, { cents: opts.cents }),
        },
      },
    ],
  };
}
