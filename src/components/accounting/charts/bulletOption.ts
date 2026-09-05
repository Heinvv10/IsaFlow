/**
 * Budget bullets: one horizontal row per account, the actual bar read
 * against the budget outline behind it.
 *
 * `BudgetVsActualLine.variance` is signed FAVOURABLY by the service — for
 * revenue it is actual − budget, for an expense it is budget − actual — so
 * `variance >= 0` means favourable in both directions and the length of the
 * two bars can never be used to work that out. `__varianceColours` is
 * exported on the option so the polarity decision is directly assertable.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { axisDomain, roleStyle, varianceColor } from './ibcs';

export function buildBudgetBulletOption(
  lines: BudgetVsActualLine[],
  palette: ChartPalette,
  opts: { limit?: number } = {},
): EChartsCoreOption {
  const ranked = [...lines]
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, opts.limit ?? 10);

  const budget = roleStyle('budget', palette);
  const actual = roleStyle('actual', palette);
  const colours = ranked.map((l) => varianceColor(l.variance >= 0, palette) ?? palette.ink);

  return {
    __varianceColours: colours,
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const l = ranked[params[0]?.dataIndex ?? 0];
        if (!l) return '';
        return [
          l.account_name,
          `Actual ${formatMoney(l.actual_amount, { symbol: true })}`,
          `Budget ${formatMoney(l.budget_amount, { symbol: true })}`,
          `Variance ${formatMoney(l.variance, { symbol: true })}`,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'value',
      ...axisDomain(ranked.flatMap((l) => [l.actual_amount, l.budget_amount])),
      axisLabel: { color: palette.axisLabel, formatter: (v: number) => formatMoney(v) },
      splitLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: {
      type: 'category',
      data: ranked.map((l) => l.account_name),
      axisLabel: { color: palette.axisLabel },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    series: [
      {
        name: 'Budget',
        type: 'bar',
        barWidth: 18,
        itemStyle: { color: budget.color, borderColor: budget.borderColor, borderWidth: budget.borderWidth },
        data: ranked.map((l) => l.budget_amount),
      },
      {
        name: 'Actual',
        type: 'bar',
        barWidth: 8,
        barGap: '-118%',
        itemStyle: { color: actual.color },
        data: ranked.map((l) => l.actual_amount),
        label: {
          show: true,
          position: 'right',
          fontFamily: palette.figFont,
          fontSize: 10,
          formatter: (p: { dataIndex: number }) => {
            const l = ranked[p.dataIndex];
            return l ? formatMoney(l.variance) : '';
          },
          color: (p: { dataIndex: number }) => {
            const l = ranked[p.dataIndex];
            return l ? varianceColor(l.variance >= 0, palette) ?? palette.ink : palette.ink;
          },
        },
      },
    ],
  };
}
