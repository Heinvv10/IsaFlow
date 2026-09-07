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

import { formatDays, formatMoney, formatPctLevel, type MoneyScale } from '@/lib/format/money';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import { sharedDomain, smallMultipleOption } from '@/modules/accounting/services/packs/packLineChartOptions';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackChartSpec } from './packPageModel';

/**
 * A page-10 panel: 82mm wide, 36mm tall.
 *
 * Six panels are drawn three across, so the page carries two rows of them —
 * plus a title, a caption and two disclosures — inside a LANDSCAPE content
 * box that is 168mm tall, not 255mm. At 72mm a row the panels alone came to
 * 164mm and the page printed on two landscape sheets; at the 48mm inline
 * rung two rows are 104mm, and the page still printed on two sheets for any
 * company whose page title wraps to three lines or whose trend draws fewer
 * than six panels (which adds a disclosure saying why).
 *
 * 36mm is BELOW spec §5.6's 48/72/110 rungs, deliberately: those rungs were
 * chosen against a 255mm portrait box, and this is the one page in the pack
 * printed into a 168mm one. Two rows plus their gutter is 80mm, which leaves
 * the title, caption and both disclosures room on the widest title any
 * fixture produces. `CHART_HEIGHT_MM` is left alone — every portrait chart
 * still sits on the rungs.
 */
const PANEL = { widthMm: 82, heightMm: 36 };

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
  { id: 'trend-gross-margin', name: 'Gross margin', pick: (p) => p.grossMarginPct, format: (n) => formatPctLevel(n) },
  { id: 'trend-debtor-days', name: 'Debtor days', pick: (p) => p.debtorDays, format: (n) => formatDays(n, 1) },
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

/**
 * Page 8's closing-cash line — 36mm, the same height as a trends panel.
 *
 * It shares the busiest page in the pack with a statement table that can
 * carry four footnotes, a bridge, and two disclosures, and that page printed
 * on two sheets for the live demo company. This chart is a CONTEXT strip —
 * where cash has been standing over twelve periods — beside a bridge that
 * answers the period's own question, so it is the one to give the height
 * back. See `HALF` in `packPageCharts.ts` for the bridge's own rung.
 */
const CASH_TREND_FULL = { widthMm: 170, heightMm: 36 };

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
  // NAMED PERIODS, not just a count. This panel shares a sheet with the cash
  // table, whose Opening cash is the START OF THE REPORTING PERIOD, while this
  // series opens wherever the twelve-month window does — (125) at 1 January
  // against (115) at the previous October, two different numbers for the word
  // "opening", with nothing on the sheet saying they were different series.
  // The endpoints carry their own months now, so the reader can see that.
  return {
    id: 'cash-trend',
    title:
      `Closing cash ${direction} from ${money(first)} at ${points[0]!.label} ` +
      `to ${money(last)} at ${points[points.length - 1]!.label}, over ${points.length} periods.`,
    kind: 'line',
    svg: renderChartSvg(smallMultipleOption(points, domain, money), CASH_TREND_FULL),
    heightMm: CASH_TREND_FULL.heightMm,
    // What that sentence ASSERTS, as a number, so the gate can hold it
    // against the cash table's own `Closing cash` row on the same page. The
    // rendered pack stated `(532)` in the table and `(752)` here, and nothing
    // in the pipeline could see it — see `checkChartClaims`.
    claims: [{ label: 'Closing cash', value: last }],
  };
}
