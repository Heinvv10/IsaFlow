/**
 * Account x month variance heatmap (budgets P3 spec §2.7).
 *
 * Rows are accounts, the top 15 by |window variance| (an unbudgeted account,
 * which has no variance, after them) unless "show all"; columns are the
 * window's months. A cell is the engine's monthly `variance` (actual − budget)
 * and is coloured by `varianceColor(favourable)` ALONE, at an opacity
 * proportional to |v| / max|v|. There is deliberately no `visualMap`: a colour
 * ramp would issue green and red outside `varianceColor`. A month with no
 * budget is hatched with the forecast role's decal and never coloured.
 *
 * A `custom` series draws the cells (CustomChart is registered in
 * `lib/charts/echarts.ts`; the heatmap series is not), which also lets the
 * decal render in the SSR SVG.
 *
 * The month in progress (`inProgressMonth`) holds part-month actuals against a
 * whole month's budget: not a variance yet. Its cells are drawn neutral (the
 * axis ink), labelled "*" on the axis, said so in the tooltip, and left out of
 * the colour scale, so the complete months keep their strength.
 *
 * Labels: account names are ledger data. The tooltip escapes them
 * (`escapeHtml`); the axis is drawn as text by zrender, not HTML. Below
 * `NARROW_WIDTH` the names truncate at a smaller size (full name in the
 * tooltip) so the cells keep the width: `containLabel` alone would keep a long
 * name inside the box by squeezing the plot to nothing. The month labels stand
 * vertical there, so twelve months clear each other on a phone. Proved painted
 * by tests/unit/services/reports/charts/varianceHeatmapLegibility.test.ts.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type { CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts';
import { formatStatementFigure } from '@/lib/format/money';
import type { TrackingLine } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import type { ChartPalette } from './chartTypes';
import { escapeHtml } from './escapeHtml';
import { roleStyle, varianceColor } from './ibcs';
import { NARROW_WIDTH } from './waterfallOption';

export const HEATMAP_DEFAULT_LIMIT = 15;
/** Label width (px) wide and below NARROW_WIDTH; past it a name truncates with an ellipsis. */
const WIDE_LABEL_WIDTH = 260;
const NARROW_LABEL_WIDTH = 120;
const NARROW_FONT = 10;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1] ?? key} ${key.slice(2, 4)}`;

/** The accounts drawn, largest |variance| first. */
export function heatmapAccounts(lines: readonly TrackingLine[], opts: { limit?: number; showAll?: boolean } = {}): TrackingLine[] {
  const ranked = [...lines].sort((a, b) => {
    if (a.variance === null || b.variance === null) {
      if (a.variance !== null) return -1;
      if (b.variance !== null) return 1;
      return Math.abs(b.actual) - Math.abs(a.actual);
    }
    return Math.abs(b.variance) - Math.abs(a.variance);
  });
  return opts.showAll ? ranked : ranked.slice(0, opts.limit ?? HEATMAP_DEFAULT_LIMIT);
}

interface Cell { x: number; y: number; line: TrackingLine; month: string; actual: number; budget: number | null; above: boolean; variance: number | null; favourable: boolean | null }

export function buildVarianceHeatmapOption(
  lines: readonly TrackingLine[],
  months: readonly string[],
  palette: ChartPalette,
  opts: { limit?: number; showAll?: boolean; inProgressMonth?: string | null } = {},
): EChartsCoreOption | null {
  const inProgress = (month: string) => month === opts.inProgressMonth;
  // ECharts draws category index 0 at the BOTTOM: reversed, the largest |variance| is on top.
  const rows = heatmapAccounts(lines, opts).reverse();
  if (rows.length === 0 || months.length === 0) return null;
  const cells: Cell[] = [];
  rows.forEach((line, y) => {
    months.forEach((month, x) => {
      const m = line.monthly.find((v) => v.month === month);
      cells.push({
        x, y, line, month, actual: m?.actual ?? 0, budget: m?.budget ?? null, above: m?.budgetAboveFilter ?? false,
        variance: m?.variance ?? null, favourable: m?.favourable ?? null,
      });
    });
  });
  // The month in progress is not on the scale: its part-month figure would wash out the complete months.
  const max = Math.max(0, ...cells.map((c) => (c.variance === null || inProgress(c.month) ? 0 : Math.abs(c.variance))));
  const forecast = roleStyle('forecast', palette);

  const renderItem = (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
    const c = cells[params.dataIndex];
    if (!c) return undefined;
    const [cx = 0, cy = 0] = api.coord([c.x, c.y]);
    const sizeRaw = api.size ? api.size([1, 1]) : undefined;
    const [w = 20, h = 20] = Array.isArray(sizeRaw) ? sizeRaw : [20, 20];
    const shape = { x: cx - w / 2 + 1, y: cy - h / 2 + 1, width: Math.max(0, w - 2), height: Math.max(0, h - 2) };
    if (c.variance === null) {
      return { type: 'rect' as const, shape, style: { fill: forecast.color, stroke: forecast.borderColor, lineWidth: forecast.borderWidth, decal: forecast.decal } };
    }
    if (inProgress(c.month)) return { type: 'rect' as const, shape, style: { fill: palette.axisLine, opacity: 0.35 } };
    const opacity = max === 0 ? 0 : Math.round((Math.abs(c.variance) / max) * 1000) / 1000;
    return { type: 'rect' as const, shape, style: { fill: varianceColor(c.favourable ?? undefined, palette), opacity } };
  };

  return {
    media: [{
      query: { maxWidth: NARROW_WIDTH },
      option: {
        yAxis: { axisLabel: { width: NARROW_LABEL_WIDTH, overflow: 'truncate', fontSize: NARROW_FONT } },
        xAxis: { axisLabel: { rotate: 90, fontSize: NARROW_FONT } },
      },
    }],
    grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: (p: { dataIndex: number }) => {
        const c = cells[p.dataIndex];
        if (!c) return '';
        const head = `${escapeHtml(`${c.line.accountCode} ${c.line.accountName}`)}<br/>${monthLabel(c.month)}`;
        const actual = `Actual ${formatStatementFigure(c.actual, { symbol: true })}`;
        if (inProgress(c.month) && c.budget !== null) {
          return `${head}<br/>${actual}<br/>Budget ${formatStatementFigure(c.budget, { symbol: true })}<br/>In progress: actuals to date against the whole month's budget, not yet a variance`;
        }
        if (c.budget === null || c.variance === null) {
          // A month budgeted only above the filter has a budget, just not one this filter can split.
          return `${head}<br/>${actual}<br/>${c.above ? 'Budgeted above this filter' : 'No budget for this month'}`;
        }
        return `${head}<br/>${actual}<br/>Budget ${formatStatementFigure(c.budget, { symbol: true })}<br/>Var ${formatStatementFigure(c.variance, { symbol: true })}`;
      },
    },
    xAxis: {
      type: 'category',
      data: months.map((m) => (inProgress(m) ? `${monthLabel(m)} *` : monthLabel(m))),
      axisLabel: { color: palette.axisLabel, interval: 0 },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: {
      type: 'category',
      data: rows.map((l) => `${l.accountCode} ${l.accountName}`),
      axisLabel: { color: palette.axisLabel, interval: 0, width: WIDE_LABEL_WIDTH, overflow: 'truncate' },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    series: [{ name: 'variance', type: 'custom', renderItem, clip: true, data: cells.map((c) => [c.x, c.y]) }],
  };
}
