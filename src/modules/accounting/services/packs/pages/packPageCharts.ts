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
  // Only categories the figure set actually CAPTURED get a bar. `?? 0` drew
  // a flat "Investing" bar for a company whose cash table one block above
  // said capital expenditure was not captured — the same figure telling two
  // stories on one page. An uncaptured category is absorbed by the named
  // residual below, which is honest about not knowing.
  const movements: Array<{ label: string; value: number }> = [];
  if (current.operatingCashFlow !== undefined) movements.push({ label: 'Operating', value: current.operatingCashFlow });
  if (current.capitalExpenditure !== undefined) movements.push({ label: 'Investing', value: -current.capitalExpenditure });
  if (current.financingCashFlow !== undefined) movements.push({ label: 'Financing', value: current.financingCashFlow });
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
 * net profit, cash and debtor days. All six are drawn from `PackTrendPoint`'s
 * series.
 *
 * They do NOT all share one y-domain: gross margin % and debtor days are
 * different UNITS from the four money series (Rand vs a percentage, Rand vs
 * a day count), and a shared scale across units is not a wider view of the
 * same row, it is nonsense — a 45% gross margin plotted against a R4.2m
 * revenue axis is indistinguishable from zero. Grouped instead:
 *   - money:  revenue, operating expenses, net profit, cash — one domain.
 *   - each ratio panel (gross margin %, debtor days) keeps its OWN domain,
 *     because the two are themselves different units from each other.
 * Within the money group the shared-scale rule from spec §4.A still holds in
 * full: per-panel autoscaling there would draw a flat metric and a
 * collapsing one with the same apparent slope, which is the failure the rule
 * exists to stop.
 */
export const TRENDS_PANELS_SPECIFIED = 6;

interface MoneyPanel { id: string; name: string; pick: (p: PackTrendPoint) => number }
interface RatioPanel {
  id: string;
  name: string;
  pick: (p: PackTrendPoint) => number | null;
  /** How the panel's own end-label formats a value — a percentage and a day
   *  count are not printed through `formatMoney`. */
  format: (n: number) => string;
}

const MONEY_PANELS: MoneyPanel[] = [
  { id: 'trend-revenue', name: 'Revenue', pick: (p) => p.revenue },
  { id: 'trend-operating-expenses', name: 'Operating expenses', pick: (p) => p.operatingExpenses },
  { id: 'trend-net-profit', name: 'Net profit', pick: (p) => p.netProfit },
  { id: 'trend-cash', name: 'Cash', pick: (p) => p.cash },
];

const RATIO_PANELS: RatioPanel[] = [
  { id: 'trend-gross-margin', name: 'Gross margin', pick: (p) => p.grossMarginPct, format: (n) => `${n.toFixed(1)}%` },
  { id: 'trend-debtor-days', name: 'Debtor days', pick: (p) => p.debtorDays, format: (n) => `${n.toFixed(1)} days` },
];

function moneyPanel(panel: MoneyPanel, trend: PackTrendPoint[], domain: { min: number; max: number }): PackChartSpec {
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
}

/**
 * A ratio panel, or null when no month in the window has a meaningful value
 * — e.g. a company with no revenue at all across the whole trend. Months
 * where the ratio is not meaningful (R-P44/R-P45: no revenue that month) are
 * dropped from the line rather than plotted as a false zero; a gap in the
 * series is honest, a zero is a claim about a debtor book that collected
 * nothing.
 */
function ratioPanel(panel: RatioPanel, trend: PackTrendPoint[]): PackChartSpec | null {
  const points = trend
    .filter((point) => panel.pick(point) !== null)
    .map((point) => ({ label: point.label, value: panel.pick(point) as number }));
  if (points.length === 0) return null;

  const domain = sharedDomain([points.map((p) => p.value)]);
  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;
  const direction = last >= first ? 'rose' : 'fell';
  return {
    id: panel.id,
    title: `${panel.name} ${direction} from ${panel.format(first)} to ${panel.format(last)} over ${points.length} periods.`,
    kind: 'line',
    svg: renderChartSvg(smallMultipleOption(points, domain), PANEL),
    heightMm: PANEL.heightMm,
  };
}

export function buildTrendPanels(trend: PackTrendPoint[]): PackChartSpec[] {
  if (trend.length === 0) return [];

  // One row of panels, so ONE y-domain across the money panels (spec §4.A
  // page 10). Per-panel scales would draw a flat metric and a collapsing one
  // with the same apparent slope, which is a chart that misreports direction.
  const moneyDomain = sharedDomain(MONEY_PANELS.map((panel) => trend.map(panel.pick)));
  const money = MONEY_PANELS.map((panel) => moneyPanel(panel, trend, moneyDomain));

  // Spec order: revenue, gross margin %, operating expenses, net profit,
  // cash, debtor days.
  const panels: PackChartSpec[] = [
    money[0]!,
    ratioPanel(RATIO_PANELS[0]!, trend),
    money[1]!,
    money[2]!,
    money[3]!,
    ratioPanel(RATIO_PANELS[1]!, trend),
  ].filter((p): p is PackChartSpec => p !== null);

  return panels;
}

const CASH_TREND_FULL = { widthMm: 170, heightMm: CHART_HEIGHT_MM.half };

/**
 * Page 8 — the closing-cash line spec §4.A page 8 asks for, drawn from the
 * trend's month-end cash positions. Distinct from `buildCashWaterfallChart`
 * above, which bridges opening to closing cash for the CURRENT period only;
 * this is the multi-period LEVEL, which is a different question ("where has
 * cash been standing") from the bridge's ("what moved it this period").
 *
 * Null when there is no trend series to plot — the same "say why, don't
 * invent" rule the rest of this file follows rather than opening at zero.
 */
export function buildCashTrendChart(trend: PackTrendPoint[]): PackChartSpec | null {
  if (trend.length === 0) return null;
  const points = trend.map((p) => ({ label: p.label, value: p.cash }));
  const domain = sharedDomain([points.map((p) => p.value)]);
  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;
  const direction = last >= first ? 'rose' : 'fell';
  return {
    id: 'cash-trend',
    title: `Closing cash ${direction} from ${formatMoney(first)} to ${formatMoney(last)} over ${points.length} periods.`,
    kind: 'line',
    svg: renderChartSvg(smallMultipleOption(points, domain), CASH_TREND_FULL),
    heightMm: CASH_TREND_FULL.heightMm,
  };
}
