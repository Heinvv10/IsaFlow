/**
 * Budget bullets: one horizontal row per account, the actual bar read
 * against the budget outline behind it.
 *
 * The printed variance (tooltip and label) is the line's `movement`, actual −
 * budget, as on the Budget vs Actual screen and CSV. Whether that is good news
 * comes from the line's `favourable` alone — the length of the two bars can
 * never be used to work it out. The polarity is issued once, by
 * `varianceColor`, into the Actual series' label colour — assert that colour
 * rather than adding a hook to the option the chart does not read. Rows are
 * ranked by |variance|, which equals |movement|.
 * Only BUDGETED lines are drawn, coloured by their `favourable`: an account
 * with no budget has no variance against a plan, and the Budget vs Actual
 * screen, CSV and MCP all leave it unjudged (budgets P0).
 *
 * The variance label is set on the data ITEM of whichever bar is longer
 * (budget outline or actual), so it always starts past both bars and never
 * sits on the outline (unreadable in dark), and its colour is a per-item
 * string: ECharts never honoured a label colour given as a function, so the
 * label was painted in the default ink. The grid's right margin holds the
 * widest label (a conservative width per character), so none is clipped. Below NARROW_WIDTH the value axis has
 * fewer ticks at a smaller size (and hides any that would still touch), and
 * long names truncate (full name in the tooltip). Proved painted by
 * tests/unit/services/reports/charts/bulletLegibility.test.ts.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { formatStatementFigure } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { escapeHtml } from './escapeHtml';
import { axisDomain, roleStyle, varianceColor } from './ibcs';
import { NARROW_WIDTH } from './waterfallOption';

const LABEL_FONT = 10;
const NARROW_NAME_WIDTH = 110;

export function buildBudgetBulletOption(
  lines: BudgetVsActualLine[],
  palette: ChartPalette,
  opts: { limit?: number } = {},
): EChartsCoreOption {
  const ranked = lines
    .filter((l) => l.budgeted)
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, opts.limit ?? 10);
  // ECharts draws a horizontal category axis with index 0 at the BOTTOM.
  // Reversing here puts the largest |variance| LAST in `rows`, which is
  // what lands at the TOP of the chart — where a reader looks first. Every
  // array below (yAxis, both series, tooltip/label lookups, colours) is
  // built from this same `rows` order so index k always means the same
  // account everywhere in the option.
  const rows = [...ranked].reverse();

  const budget = roleStyle('budget', palette);
  const actual = roleStyle('actual', palette);
  const labelText = (l: BudgetVsActualLine) => formatStatementFigure(l.movement);
  const labelColour = (l: BudgetVsActualLine) => varianceColor(l.favourable ?? undefined, palette) ?? palette.ink;
  // The label rides on the longer bar's item: past both bars, whichever is longer.
  const item = (l: BudgetVsActualLine, value: number, longer: boolean) => ({
    value, label: { show: longer, color: labelColour(l) },
  });
  // Figures are digits, spaces and brackets: 0.62 em a character is wider than any of them.
  const widest = Math.max(0, ...rows.map((l) => labelText(l).length * LABEL_FONT * 0.62));
  const label = {
    show: false, position: 'right' as const, distance: 4, fontFamily: palette.figFont, fontSize: LABEL_FONT,
    formatter: (p: { dataIndex: number }) => {
      const l = rows[p.dataIndex];
      return l ? labelText(l) : '';
    },
  };

  return {
    media: [{
      query: { maxWidth: NARROW_WIDTH },
      option: {
        xAxis: { splitNumber: 2, axisLabel: { fontSize: LABEL_FONT, hideOverlap: true } },
        yAxis: { axisLabel: { fontSize: LABEL_FONT, width: NARROW_NAME_WIDTH, overflow: 'truncate' } },
      },
    }],
    grid: { left: 8, right: Math.ceil(widest) + 12, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const l = rows[params[0]?.dataIndex ?? 0];
        if (!l) return '';
        return [
          escapeHtml(l.account_name),
          `Actual ${formatStatementFigure(l.actual_amount, { symbol: true })}`,
          `Budget ${formatStatementFigure(l.budget_amount, { symbol: true })}`,
          // The printed sign is the movement (actual − budget), as on the
          // Budget vs Actual screen and CSV; good/bad news is the colour.
          `Variance ${formatStatementFigure(l.movement, { symbol: true })}`,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'value',
      ...axisDomain(rows.flatMap((l) => [l.actual_amount, l.budget_amount])),
      axisLabel: { color: palette.axisLabel, formatter: (v: number) => formatStatementFigure(v) },
      splitLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: {
      type: 'category',
      data: rows.map((l) => l.account_name),
      axisLabel: { color: palette.axisLabel },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    series: [
      {
        name: 'Budget',
        type: 'bar',
        barWidth: 18,
        itemStyle: { color: budget.color, borderColor: budget.borderColor, borderWidth: budget.borderWidth },
        label,
        data: rows.map((l) => item(l, l.budget_amount, Math.abs(l.budget_amount) > Math.abs(l.actual_amount))),
      },
      {
        name: 'Actual',
        type: 'bar',
        barWidth: 8,
        barGap: '-118%',
        itemStyle: { color: actual.color },
        label,
        data: rows.map((l) => item(l, l.actual_amount, Math.abs(l.actual_amount) >= Math.abs(l.budget_amount))),
      },
    ],
  };
}
