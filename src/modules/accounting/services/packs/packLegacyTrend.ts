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
import { trendOption } from './packChartOptions';
import { monthLabel, partialMonthClause } from './pages/packPartialMonth';

/** The type size ECharts sets a bar's figure in. */
const FIGURE_PX = 12;
/** Bars that each carry a figure: about half a year, at 718px. */
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
    grid: Record<string, unknown>;
    series: Array<Record<string, unknown>>;
  };
  const labelled = (index: number) => drawn.length <= LABEL_EVERY_BAR_UP_TO || index === drawn.length - 1;
  // The last figure is centred on the last bar, half a band inside the plot's
  // right edge — at twelve months on 718px about 25px, less than half a
  // nine-digit figure. Room for half the figure and its halo is kept beyond
  // the plot, not counting that half band: it depends on the width drawn at.
  const last = drawn[drawn.length - 1];
  const reach = last === undefined ? 0 : Math.ceil(packFigureWidthPx(formatMoney(last.revenue, { scale }), FIGURE_PX) / 2 + 2);
  return {
    ...base,
    grid: { ...base.grid, top: 48, right: reach },
    legend: { data: ['Revenue'], top: 0, right: 0, itemWidth: 10, itemHeight: 10 },
    series: base.series.map((series) => ({
      ...series,
      name: 'Revenue',
      label: {
        show: true,
        position: 'top',
        fontSize: FIGURE_PX,
        formatter: (param: { dataIndex: number; value: number }) => (labelled(param.dataIndex) ? formatMoney(param.value, { scale }) : ''),
      },
    })),
  };
}
