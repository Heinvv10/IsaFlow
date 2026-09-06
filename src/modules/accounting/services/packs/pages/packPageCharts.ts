/**
 * The board pack's charts, as `PackChartSpec`s the pages carry directly.
 *
 * Every SVG here comes out of `renderChartSvg`, which is the ONLY producer of
 * a `TrustedChartSvg` — and this module runs in the same process that renders
 * the page (R-P41), so no SVG string ever crosses a JSON boundary and loses
 * that guarantee.
 *
 * The waterfall geometry is `buildProfitWaterfall`'s, unchanged. `waterfallBars`
 * mirrors what is DRAWN, `start` and `end` copied from each step, so the
 * integrity gate can check the bridge without re-parsing the SVG. One thing
 * that mirroring cannot express: `PackWaterfallBar.kind` has no 'subtotal'
 * member, while a statement bridge resets its mid-statement subtotals (Gross
 * Profit, Net Profit) to `start: 0`. Those bars are reported by their drawn
 * direction, which is true of the rectangle but is NOT a link in a single
 * arithmetic chain — a gate that walks kinds must know a bar starting at zero
 * restarts the bridge.
 */

import { formatMoney } from '@/lib/format/money';
import { buildProfitWaterfall, type WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import {
  compositionBarOption,
  waterfallOption,
  type CompositionSeries,
} from '@/modules/accounting/services/packs/packChartOptions';
import { sharedDomain, smallMultipleOption } from '@/modules/accounting/services/packs/packLineChartOptions';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackChartSpec, PackWaterfallBar } from './packPageModel';

const FULL = { widthMm: 170, heightMm: CHART_HEIGHT_MM.full };
const PANEL = { widthMm: 82, heightMm: CHART_HEIGHT_MM.half };

function toBars(steps: WaterfallStep[]): PackWaterfallBar[] {
  return steps.map((step, index) => ({
    label: step.label,
    start: step.start,
    end: step.end,
    kind:
      index === 0 ? 'open'
      : index === steps.length - 1 ? 'close'
      : step.end >= step.start ? 'increase'
      : 'decrease',
  }));
}

/** Page 6 — revenue to net profit, IBCS notation. */
export function buildProfitWaterfallChart(set: PackFigureSet): PackChartSpec {
  const f = set.current;
  const steps = buildProfitWaterfall({
    revenue: f.revenue,
    costOfSales: f.costOfSales,
    grossProfit: f.revenue - f.costOfSales,
    operatingExpenses: f.operatingExpenses,
    otherIncome: f.otherIncome ?? 0,
    otherExpenses: f.otherExpenses ?? 0,
    netProfit: f.netProfit,
  });
  return {
    id: 'profit-bridge',
    title: `Revenue of ${formatMoney(f.revenue)} bridges to net profit of ${formatMoney(f.netProfit)}.`,
    kind: 'waterfall',
    svg: renderChartSvg(waterfallOption(steps), FULL),
    heightMm: FULL.heightMm,
    waterfallBars: toBars(steps),
  };
}

/**
 * Page 8 — the cash bridge, or nothing.
 *
 * Opening cash is the prior period's closing balance, so a company with no
 * prior period has no bridge to draw and this returns null rather than
 * opening the bar at zero.
 *
 * The three cash categories the pack captures (operating, investing,
 * financing) do NOT in general reconcile opening cash to closing cash — the
 * figure set carries no reconciling items — so the residual is drawn as its
 * own named step. A bridge that silently failed to reach its own closing bar
 * would be a chart that contradicts the table above it; a bridge with an
 * unexplained-movement bar foots, and says what it does not know.
 */
export interface PackCashBridge {
  chart: PackChartSpec;
  /** The movement in cash the three captured categories do not account for.
   *  Drawn as its own named bar, and the page must say what it is. */
  residual: number;
}

export function buildCashWaterfallChart(set: PackFigureSet): PackCashBridge | null {
  const { current, prior } = set;
  if (prior === null) return null;

  const opening = prior.cash;
  const movements: Array<{ label: string; value: number }> = [
    { label: 'Operating', value: current.operatingCashFlow ?? 0 },
    { label: 'Investing', value: -(current.capitalExpenditure ?? 0) },
    { label: 'Financing', value: current.financingCashFlow ?? 0 },
  ];
  const explained = movements.reduce((sum, m) => sum + m.value, 0);
  const residual = current.cash - opening - explained;
  if (residual !== 0) movements.push({ label: 'Unexplained movement', value: residual });

  const steps: WaterfallStep[] = [
    { label: 'Opening cash', start: 0, end: opening, value: opening, isSubtotal: true, color: 'blue' },
  ];
  let running = opening;
  for (const movement of movements) {
    steps.push({
      label: movement.label,
      start: running,
      end: running + movement.value,
      value: movement.value,
      isSubtotal: false,
      color: movement.value >= 0 ? 'green' : 'red',
    });
    running += movement.value;
  }
  steps.push({ label: 'Closing cash', start: 0, end: current.cash, value: current.cash, isSubtotal: true, color: 'teal' });

  return {
    residual,
    chart: {
      id: 'cash-bridge',
      title: `Cash moved from ${formatMoney(opening)} to ${formatMoney(current.cash)} over the period.`,
      kind: 'waterfall',
      svg: renderChartSvg(waterfallOption(steps), FULL),
      heightMm: FULL.heightMm,
      waterfallBars: toBars(steps),
    },
  };
}

/** Page 7 — assets beside the funding that stands behind them, per period. */
export function buildPositionCompositionChart(set: PackFigureSet): PackChartSpec {
  const { current, prior } = set;
  const periods = prior ? ['Prior', 'Current'] : ['Current'];
  const at = (pick: (f: typeof current) => number): number[] =>
    prior ? [pick(prior), pick(current)] : [pick(current)];

  const series: CompositionSeries[] = [
    { name: 'Assets', stack: 'assets', values: at((f) => f.totalAssets) },
    { name: 'Liabilities', stack: 'funding', values: at((f) => f.totalLiabilities) },
    { name: 'Equity', stack: 'funding', values: at((f) => f.totalEquity) },
  ];

  return {
    id: 'position-composition',
    title: `Assets of ${formatMoney(current.totalAssets)} stand on liabilities of ${formatMoney(current.totalLiabilities)} and equity of ${formatMoney(current.totalEquity)}.`,
    kind: 'bar',
    svg: renderChartSvg(compositionBarOption(periods, series), FULL),
    heightMm: FULL.heightMm,
  };
}

/**
 * Page 10 — the small multiples.
 *
 * Spec §4.A names six panels: revenue, gross margin %, operating expenses,
 * net profit, cash and debtor days. `PackTrendPoint` carries three series —
 * revenue, total expenses and net profit — so three panels are drawn and the
 * page states the other three are unavailable. Gross margin needs a monthly
 * cost-of-sales split, and cash and debtor days need monthly balance-sheet
 * positions; none of the three is in the trend query, and deriving any of
 * them from what is would be an invented series on a board pack.
 */
export const TRENDS_PANELS_SPECIFIED = 6;

export function buildTrendPanels(trend: PackTrendPoint[]): PackChartSpec[] {
  if (trend.length === 0) return [];
  const series: Array<{ id: string; name: string; pick: (p: PackTrendPoint) => number }> = [
    { id: 'trend-revenue', name: 'Revenue', pick: (p) => p.revenue },
    { id: 'trend-expenses', name: 'Expenses', pick: (p) => p.expenses },
    { id: 'trend-net-profit', name: 'Net profit', pick: (p) => p.netProfit },
  ];

  // One row of panels, so ONE y-domain across all of them (spec §4.A page 10).
  // Per-panel scales would draw a flat metric and a collapsing one with the
  // same apparent slope, which is a chart that misreports direction.
  const domain = sharedDomain(series.map((panel) => trend.map(panel.pick)));

  return series.map((panel) => {
    const points = trend.map((point) => ({ label: point.label, value: panel.pick(point) }));
    const first = points[0]!.value;
    const last = points[points.length - 1]!.value;
    const direction = last >= first ? 'rose' : 'fell';
    return {
      id: panel.id,
      title: `${panel.name} ${direction} from ${formatMoney(first)} to ${formatMoney(last)} over ${points.length} periods.`,
      kind: 'line',
      svg: renderChartSvg(smallMultipleOption(points, domain), PANEL),
      heightMm: PANEL.heightMm,
    };
  });
}
