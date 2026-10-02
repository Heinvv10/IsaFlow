/**
 * THE MANAGEMENT PACK'S TWELVE-MONTH TREND — revenue by month, said in full.
 *
 * It printed nine empty months and three unlabelled bars under a heading:
 * no series name, no figure on a bar, nothing marking a month of seven days,
 * and on a company with one month of revenue a single bar with no value. So:
 *
 *  - it starts at the first month revenue is posted, and the caption says
 *    so — months before a company's ledger has anything in it are not a
 *    trend of nil, they are no trend at all;
 *  - the series is named in a legend, in the print face;
 *  - every bar carries its figure where there are few, the last where there
 *    are many (`LABEL_EVERY_BAR_UP_TO`), so the latest month is always read;
 *  - a part month is marked on its axis label and in the caption, in the
 *    words the board pack uses (`packPartialMonth`).
 */
import type { EChartsCoreOption } from 'echarts/core';
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import { packFigureWidthPx } from '@/lib/charts/packFigureWidth';
import type { PackTrendPoint } from './packTrendService';
import { distinctTicksAxis, trendOption } from './packChartOptions';
import { DEFAULT_CHART_PALETTE } from './packChartAxes';
import { monthLabel, partialMonthClause } from './pages/packPartialMonth';

/** The type size ECharts sets a bar's figure in. */
const FIGURE_PX = 12;
/** The chart's height — `PackChart`'s, which this view does not change —
 *  and the room a figure under a bar takes: ECharts' 5px gap, the type, its
 *  halo. */
const CHART_PX = 320;
const FIGURE_UNDER_BAR_PX = 5 + FIGURE_PX + 2;
/** Bars that each carry a figure: about half a year, at 657px. */
const LABEL_EVERY_BAR_UP_TO = 6;

/** The months the chart draws: from the first with revenue posted. */
export function legacyTrendMonths(points: readonly PackTrendPoint[]): PackTrendPoint[] {
  const first = points.findIndex((p) => p.revenue !== 0);
  return first < 0 ? [...points] : points.slice(first);
}

export function legacyTrendCaption(points: readonly PackTrendPoint[]): string {
  const last = points[points.length - 1];
  if (last === undefined) return '';
  if (points.every((p) => p.revenue === 0)) return `No revenue is posted in the twelve months to ${last.label}.`;
  const drawn = legacyTrendMonths(points);
  const start = drawn[0]!.label;
  const late = drawn.length < points.length ? `; none is posted before ${start}` : '';
  const part = last.partial ? ` ${partialMonthClause(last)}` : '';
  return `Revenue by month, ${start} to ${last.label}${late}.${part}`;
}

export function legacyTrendChartOption(points: readonly PackTrendPoint[], scale: MoneyScale): EChartsCoreOption {
  const drawn = legacyTrendMonths(points);
  const base = trendOption(drawn.map((p) => ({ label: monthLabel(p), value: p.revenue })), scale) as {
    grid: Record<string, unknown> & { bottom: number };
    series: Array<Record<string, unknown>>;
  };
  const top = 48;
  const labelled = (index: number) => drawn.length <= LABEL_EVERY_BAR_UP_TO || index === drawn.length - 1;
  // The last figure is centred on the last bar, half a band inside the plot's
  // right edge — at twelve months on 657px about 23px, less than half a
  // nine-digit figure. Room for half the figure and its halo is kept beyond
  // the plot, not counting that half band: it depends on the width drawn at.
  const last = drawn[drawn.length - 1];
  const reach = last === undefined ? 0 : Math.ceil(packFigureWidthPx(formatMoney(last.revenue, { scale }), FIGURE_PX) / 2 + 2);
  return {
    ...base,
    grid: { ...base.grid, top, right: reach },
    yAxis: roomUnderLowest(drawn.map((p) => p.revenue), scale, CHART_PX - top - base.grid.bottom),
    legend: { data: ['Revenue'], top: 0, right: 0, itemWidth: 10, itemHeight: 10 },
    series: base.series.map((series) => ({
      ...series,
      name: 'Revenue',
      // A month of net credit notes falls below zero, and its figure goes
      // with it: under the bar, not above it on the zero line.
      data: drawn.map((p) => ({ value: p.revenue, label: { position: p.revenue < 0 ? 'bottom' : 'top' } })),
      label: {
        show: true,
        position: 'top',
        fontSize: FIGURE_PX,
        formatter: (param: { dataIndex: number; value: number }) => (labelled(param.dataIndex) ? formatMoney(param.value, { scale }) : ''),
      },
    })),
  };
}

/**
 * The value axis, with room under the lowest bar for its figure where that
 * bar falls below zero: the figure goes under it, and the axis rounded to
 * the bar's own foot put it in the month names. The floor is lowered until
 * the rounded axis leaves the figure its room.
 */
function roomUnderLowest(values: number[], scale: MoneyScale, plotPx: number) {
  const lowest = Math.min(...values);
  let axis = distinctTicksAxis(values, DEFAULT_CHART_PALETTE, scale);
  for (let pass = 0; lowest < 0 && pass < 8; pass += 1) {
    const span = Number(axis.max) - Number(axis.min);
    const room = ((lowest - Number(axis.min)) / span) * plotPx;
    if (room >= FIGURE_UNDER_BAR_PX) break;
    axis = distinctTicksAxis([...values, Number(axis.min) - (span * (FIGURE_UNDER_BAR_PX - room)) / plotPx], DEFAULT_CHART_PALETTE, scale);
  }
  return axis;
}
