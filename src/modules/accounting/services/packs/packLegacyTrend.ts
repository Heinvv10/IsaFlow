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
/** Paper beyond a figure's glyphs on each side of its ground. */
const GROUND_HALO_PX = 3;

/** The figure with its grouping spaces as plain spaces: the same advance in
 *  the face, but one zrender's ruler measures as a space rather than a full
 *  em, so the ground it sizes is the figure's width and not a bar wider. */
const groundable = (figure: string): string => figure.replace(/\u00a0/g, ' ');
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
  const every = drawn.length <= LABEL_EVERY_BAR_UP_TO;
  const labelled = (index: number) => every || index === drawn.length - 1;
  // Where every bar is labelled, each figure is centred on its bar, and the
  // last one needs half its width and its halo beyond the plot. Where only
  // the last is, its bars are narrow — 46px a band at twelve months on 657px
  // — and a centred nine-digit figure's ground lay on the bar before it; it
  // starts at its own bar's left edge instead and runs right, past the plot,
  // so the whole figure and its halo are kept beyond it. Neither counts the
  // half band inside the plot: that depends on the width drawn at.
  const last = drawn[drawn.length - 1];
  const lastWidth = last === undefined ? 0 : packFigureWidthPx(formatMoney(last.revenue, { scale }), FIGURE_PX) + 2 * GROUND_HALO_PX;
  const reach = Math.ceil(every ? lastWidth / 2 : lastWidth);
  return {
    ...base,
    grid: { ...base.grid, top, right: reach },
    yAxis: roomUnderLowest(drawn.map((p) => p.revenue), scale, CHART_PX - top - base.grid.bottom),
    legend: { data: ['Revenue'], top: 0, right: 0, itemWidth: 10, itemHeight: 10 },
    series: base.series.map((series) => ({
      ...series,
      name: 'Revenue',
      // A month of net credit notes falls below zero, and its figure goes
      // with it: under the bar, not above it on the zero line. AND EVERY
      // FIGURE STANDS ON PAPER, as a bridge's does: the (6 000 000) gridline
      // ran through Brightsphere's (5 535 000). The ground is the figure's
      // own advances wide plus a halo each side — zrender's ruler charges a
      // grouping space a full em, and its ground ran onto the next bar.
      data: drawn.map((p, index) => ({
        value: p.revenue,
        label: !labelled(index) ? { show: false } : {
          // The face's own advances: zrender's ruler is short on digits.
          width: Math.ceil(packFigureWidthPx(formatMoney(p.revenue, { scale }), FIGURE_PX)),
          ...(every
            ? { position: p.revenue < 0 ? 'bottom' : 'top' }
            : { position: p.revenue < 0 ? ['0%', '100%'] : ['0%', 0], align: 'left', verticalAlign: p.revenue < 0 ? 'top' : 'bottom', offset: [0, p.revenue < 0 ? 5 : -5] }),
          padding: [0, GROUND_HALO_PX],
          backgroundColor: DEFAULT_CHART_PALETTE.paper,
        },
      })),
      label: {
        show: true,
        position: 'top',
        fontSize: FIGURE_PX,
        formatter: (param: { value: number }) => groundable(formatMoney(param.value, { scale })),
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
