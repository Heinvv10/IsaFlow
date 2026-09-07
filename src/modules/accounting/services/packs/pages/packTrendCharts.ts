/**
 * The board pack's TREND charts — page 10's small multiples and page 8's
 * closing-cash line — split out of `packPageCharts.ts`, which was at the
 * 300-line cap when the profit bridge gained its residual step.
 *
 * The split follows the shape of the work rather than the line count: a
 * BRIDGE asserts arithmetic between two endpoints and is what the integrity
 * gate walks; a TREND draws a level over time and asserts nothing that can be
 * footed. Nothing below changed in the move. `packPageCharts.ts` re-exports
 * every name here, so existing import paths still resolve.
 */

import { formatMoney, type MoneyScale } from '@/lib/format/money';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import { sharedDomain, smallMultipleOption } from '@/modules/accounting/services/packs/packLineChartOptions';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackChartSpec } from './packPageModel';

/**
 * A page-10 panel: 82mm wide, and INLINE height (48mm) rather than half.
 *
 * Six panels are drawn three across, so the page carries two rows of them —
 * plus a title, a caption and two disclosures — inside a LANDSCAPE content
 * box that is 168mm tall, not 255mm. At 72mm a row the panels alone came to
 * 164mm and the page printed on two landscape sheets.
 */
const PANEL = { widthMm: 82, heightMm: CHART_HEIGHT_MM.inline };

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

function moneyPanel(
  panel: MoneyPanel,
  trend: PackTrendPoint[],
  domain: { min: number; max: number },
  scale: MoneyScale,
): PackChartSpec {
  const points = trend.map((point) => ({ label: point.label, value: panel.pick(point) }));
  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;
  const direction = last >= first ? 'rose' : 'fell';
  const money = (n: number) => formatMoney(n, { scale });
  return {
    id: panel.id,
    title: `${panel.name} ${direction} from ${money(first)} to ${money(last)} over ${points.length} periods.`,
    kind: 'line',
    svg: renderChartSvg(smallMultipleOption(points, domain, money), PANEL),
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
    svg: renderChartSvg(smallMultipleOption(points, domain, panel.format), PANEL),
    heightMm: PANEL.heightMm,
  };
}

export function buildTrendPanels(trend: PackTrendPoint[], scale: MoneyScale): PackChartSpec[] {
  if (trend.length === 0) return [];

  // One row of panels, so ONE y-domain across the money panels (spec §4.A
  // page 10). Per-panel scales would draw a flat metric and a collapsing one
  // with the same apparent slope, which is a chart that misreports direction.
  const moneyDomain = sharedDomain(MONEY_PANELS.map((panel) => trend.map(panel.pick)));
  const money = MONEY_PANELS.map((panel) => moneyPanel(panel, trend, moneyDomain, scale));

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

/** Page 8's closing-cash line — inline height, because it shares its page
 *  with a statement table and a bridge. See `HALF` in `packPageCharts.ts`. */
const CASH_TREND_FULL = { widthMm: 170, heightMm: CHART_HEIGHT_MM.inline };

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
export function buildCashTrendChart(trend: PackTrendPoint[], scale: MoneyScale): PackChartSpec | null {
  if (trend.length === 0) return null;
  const points = trend.map((p) => ({ label: p.label, value: p.cash }));
  const domain = sharedDomain([points.map((p) => p.value)]);
  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;
  const direction = last >= first ? 'rose' : 'fell';
  const money = (n: number) => formatMoney(n, { scale });
  return {
    id: 'cash-trend',
    title: `Closing cash ${direction} from ${money(first)} to ${money(last)} over ${points.length} periods.`,
    kind: 'line',
    svg: renderChartSvg(smallMultipleOption(points, domain, money), CASH_TREND_FULL),
    heightMm: CASH_TREND_FULL.heightMm,
  };
}
