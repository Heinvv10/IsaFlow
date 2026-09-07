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

import { formatDays, formatMoney, formatPctLevel, inProse, type MoneyScale } from '@/lib/format/money';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import { sharedDomain, smallMultipleOption } from '@/modules/accounting/services/packs/packLineChartOptions';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import {
  creditMonthClause,
  dominantPoint,
  moneyPanelScales,
  movementSentence,
  type Domain,
  type ScaleDominator,
} from './packTrendScale';
import type { PackChartSpec } from './packPageModel';

/**
 * A page-10 panel: 83mm wide, 48mm tall, TWO ACROSS ON A PORTRAIT SHEET.
 *
 * It was 82 x 36, three across, on the one landscape sheet in a
 * twelve-sheet portrait pack. Landscape was chosen to fit six panels in two
 * rows, and it cost more than it bought: printed and bound, one sheet in
 * twelve turns sideways, and a 168mm content box left the page the tightest
 * in the pack — 0.9mm of slack on Brightsphere, which is what made its
 * disclosures the first prose the fitter took.
 *
 * Two across is 83mm a panel — within a millimetre of the old measure — and
 * three rows of 48mm plus their gutters come to 160mm in a 255mm box. The
 * page gains a third more panel height, which is the other half of what the
 * trends page needed (three of its panels were drawing one to two pixels of
 * excursion), and the pack stops having a sheet that reads sideways.
 *
 * 48mm is spec §5.6's inline rung, which the portrait pages are all set on.
 * The 36mm the landscape sheet used sat below every rung, deliberately,
 * because that page was printed into a box two thirds the height.
 */
const PANEL = { widthMm: 83, heightMm: 48 };

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
  scale: MoneyScale,
  drawn: { domain: Domain; shared: boolean; ownSharePct: number },
  dominant: { label: string; value: number; sharePct: number; creditMonth: string | null } | null,
): PackChartSpec {
  const points = trend.map((point) => ({ label: point.label, value: panel.pick(point) }));
  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;
  const money = (n: number) => formatMoney(n, { scale });
  const prose = (n: number) => inProse(money(n));
  const clauses = [movementSentence(panel.name, prose(first), prose(last), points.length, last >= first)];
  // A PANEL THAT DOES NOT SHARE THE SCALE SAYS SO, IN ITS OWN TITLE. The
  // page's scale note names it too; this is the half a reader meets while
  // looking at the line, which is where a rescaled axis actually misleads.
  if (!drawn.shared) {
    clauses.push(
      `Drawn on its own scale — its range is ${drawn.ownSharePct}% of the shared money scale, `
      + 'too little to show against it.',
    );
  }
  // AND THE MONTH THAT SETS THE SCALE IS NAMED ON THE PANEL THAT CARRIES IT.
  // The rendered demo pack drew a spike of +1 908 in one month on a page
  // whose income statement totals (1 546) for the period, and no title, note
  // or caption anywhere in the document mentioned it.
  if (dominant !== null) {
    const because = dominant.creditMonth === null ? '' : `, on a month where ${dominant.creditMonth}`;
    clauses.push(
      `${dominant.label} alone is ${prose(dominant.value)}${because}, and sets `
      + `${dominant.sharePct}% of the shared money scale.`,
    );
  }
  return {
    id: panel.id,
    title: clauses.join(' '),
    kind: 'line',
    sharedScale: drawn.shared,
    svg: renderChartSvg(smallMultipleOption(points, drawn.domain, money), PANEL),
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
  const prose = (n: number) => inProse(panel.format(n));
  return {
    id: panel.id,
    title: movementSentence(panel.name, prose(first), prose(last), points.length, last >= first),
    kind: 'line',
    // A ratio panel is in its OWN unit, so it never shared the money domain
    // and cannot be read against it. Reported rather than left undefined, so
    // the page's scale note is derived from the panels rather than from a
    // second list of which ones are money.
    sharedScale: false,
    svg: renderChartSvg(smallMultipleOption(points, domain, panel.format), PANEL),
    heightMm: PANEL.heightMm,
  };
}

/**
 * Page 10's panels, and what the page has to SAY about the scale they are
 * drawn on.
 *
 * One decision, made here and reported, rather than two: `packPageBlocks`
 * writes the page's scale note off this result instead of recomputing which
 * panels share a domain. The note used to be a fixed sentence naming four
 * money panels, which was false on any pack that drew fewer.
 */
export interface TrendPanels {
  panels: PackChartSpec[];
  /** Money panels drawn on the shared y-domain, by name, in draw order. */
  sharedScale: string[];
  /** Money panels moved to their own domain, with the share of the shared
   *  range each occupies. */
  ownScale: Array<{ name: string; sharePct: number }>;
  /** Panels in a unit of their own — a percentage, a day count. */
  ownUnits: string[];
}

export function buildTrendPanels(trend: PackTrendPoint[], scale: MoneyScale): TrendPanels {
  if (trend.length === 0) {
    return { panels: [], sharedScale: [], ownScale: [], ownUnits: [] };
  }

  // ONE y-domain across the money panels (spec §4.A page 10) for every panel
  // that can be read against it. Per-panel autoscaling would draw a flat
  // metric and a collapsing one with the same apparent slope, which is a
  // chart that misreports direction — so a panel only leaves the shared
  // domain when its own range is too small to register on it, and it says so
  // when it does. See `packTrendScale.ts`.
  const series = MONEY_PANELS.map((panel) => trend.map(panel.pick));
  const { panels: scales } = moneyPanelScales(series);
  const dominator: ScaleDominator | null = dominantPoint(series);

  const money = MONEY_PANELS.map((panel, i) => {
    const carriesDominator = dominator !== null && dominator.seriesIndex === i;
    const point = carriesDominator ? trend[dominator.pointIndex] : undefined;
    return moneyPanel(panel, trend, scale, scales[i]!, point === undefined || dominator === null
      ? null
      : {
        label: point.label,
        value: dominator.value,
        sharePct: dominator.sharePct,
        creditMonth: creditMonthClause(point),
      });
  });

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

  return {
    panels,
    sharedScale: MONEY_PANELS.filter((_, i) => scales[i]!.shared).map((p) => p.name),
    ownScale: MONEY_PANELS
      .map((p, i) => ({ name: p.name, sharePct: scales[i]!.ownSharePct, shared: scales[i]!.shared }))
      .filter((p) => !p.shared)
      .map(({ name, sharePct }) => ({ name, sharePct })),
    ownUnits: RATIO_PANELS.filter((p) => panels.some((drawn) => drawn.id === p.id)).map((p) => p.name),
  };
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
  const money = (n: number) => inProse(formatMoney(n, { scale }));
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
    svg: renderChartSvg(
      smallMultipleOption(points, domain, (n) => formatMoney(n, { scale })),
      CASH_TREND_FULL,
    ),
    heightMm: CASH_TREND_FULL.heightMm,
    // What that sentence ASSERTS, as a number, so the gate can hold it
    // against the cash table's own `Closing cash` row on the same page. The
    // rendered pack stated `(532)` in the table and `(752)` here, and nothing
    // in the pipeline could see it — see `checkChartClaims`.
    claims: [{ label: 'Closing cash', value: last }],
  };
}
