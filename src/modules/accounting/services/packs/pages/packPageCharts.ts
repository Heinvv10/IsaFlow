/**
 * The board pack's charts, as `PackChartSpec`s the pages carry directly.
 *
 * Every SVG here comes out of `renderChartSvg`, which is the ONLY producer of
 * a `TrustedChartSvg` — and this module runs in the same process that renders
 * the page (R-P41), so no SVG string ever crosses a JSON boundary and loses
 * that guarantee.
 *
 * The waterfall geometry is `buildProfitWaterfall`'s. `waterfallBars` mirrors
 * what is DRAWN, `start` and `end` copied from each step, so the integrity
 * gate can check the bridge without re-parsing the SVG. A step drawn from the
 * axis mid-statement (Gross Profit, Net Profit — `isSubtotal`) is reported as
 * kind 'subtotal' rather than by its drawn direction (R-P50): the direction is
 * true of the rectangle but false of the arithmetic, and a gate walking kinds
 * has to know that such a bar RESTARTS the chain rather than continuing it.
 *
 * BOTH BRIDGES CARRY A NAMED PLUG, and neither is cosmetic. The three cash
 * categories the figure set captures do not reconcile opening to closing cash;
 * revenue less cost of sales less operating expenses does not reach net profit
 * either, because interest and tax sit between operating profit and the bottom
 * line and no field carries them. Before this, page 6's bridge drew its Net
 * Profit bar floating clear of the chain — the demo figures miss by R223,000 —
 * under a title claiming revenue "bridges to" net profit. Each gap is now its
 * own labelled bar, which is the same choice page 8 already made: a plug a
 * director can see and ask about beats a discrepancy they cannot.
 *
 * Page 10's small multiples and page 8's closing-cash line moved to
 * `packTrendCharts.ts` and are re-exported below — a trend draws a level over
 * time and asserts no arithmetic, so it has nothing in common with these two
 * beyond being a chart.
 */

import { formatMoney, type MoneyScale } from '@/lib/format/money';
import { buildProfitWaterfall, type WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import {
  compositionBarOption,
  waterfallOption,
  type CompositionSeries,
} from '@/modules/accounting/services/packs/packChartOptions';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackChartSpec, PackWaterfallBar } from './packPageModel';

/** Page 10's panels and page 8's cash line, re-exported so every existing
 *  `packPageCharts` import path still resolves after the split. */
export {
  buildCashTrendChart,
  buildTrendPanels,
  TRENDS_PANELS_SPECIFIED,
} from './packTrendCharts';

const FULL = { widthMm: 170, heightMm: CHART_HEIGHT_MM.full };

/**
 * Page 8's bridge is HALF height, not full.
 *
 * Its page is the busiest in the pack — a cash table, this bridge, a
 * multi-period cash line and up to two disclosures — and at full height it
 * was 60mm taller than an A4 content box, so it printed on two sheets with
 * the closing-cash chart stranded alone on the second. Spec §5.6's height
 * grid is 48/72/110mm and this is the middle rung; nothing is dropped from
 * the page to buy the space.
 */
const HALF = { widthMm: 170, heightMm: CHART_HEIGHT_MM.half };

function barKind(step: WaterfallStep, index: number, count: number): PackWaterfallBar['kind'] {
  if (index === 0) return 'open';
  if (index === count - 1) return 'close';
  // A mid-statement rest point, drawn from the axis. Reporting it as an
  // increase or a decrease would tell the gate to walk `start` against the
  // previous bar's `end` — which is 0 against the running chain, i.e. a
  // break in a bridge that is in fact correct.
  if (step.isSubtotal) return 'subtotal';
  return step.end >= step.start ? 'increase' : 'decrease';
}

/**
 * @param uncapturedLabel The step drawn only to make the bridge foot, if any.
 *   Marked on the bar rather than matched by label downstream: the
 *   proportion check must not break when either plug is re-worded.
 */
function toBars(steps: WaterfallStep[], uncapturedLabel: string | null): PackWaterfallBar[] {
  return steps.map((step, index) => ({
    label: step.label,
    start: step.start,
    end: step.end,
    kind: barKind(step, index, steps.length),
    ...(step.label === uncapturedLabel ? { uncaptured: true } : {}),
  }));
}

/**
 * The gap between where the P&L steps land and the net profit the ledger
 * reports — interest, tax, and anything else no field on `ReportPackFigures`
 * breaks out — inserted as its own bar before the closing one.
 *
 * Named for what is KNOWN about it, which is that the pack did not capture it
 * separately. Calling it "Interest and tax" would classify a residual nobody
 * measured, which is the kind of confident guess this pack exists to stop.
 */
export const PROFIT_UNCAPTURED_LABEL = 'Other, not separately captured';

function withUncapturedStep(steps: WaterfallStep[], netProfit: number): WaterfallStep[] {
  const closing = steps[steps.length - 1];
  const lastMovement = steps[steps.length - 2];
  if (closing === undefined || lastMovement === undefined) return steps;

  const gap = netProfit - lastMovement.end;
  if (gap === 0) return steps;

  const step: WaterfallStep = {
    label: PROFIT_UNCAPTURED_LABEL,
    start: lastMovement.end,
    end: lastMovement.end + gap,
    value: gap,
    isSubtotal: false,
    color: gap >= 0 ? 'green' : 'red',
  };
  return [...steps.slice(0, -1), step, closing];
}

/**
 * Page 6 — revenue to net profit, IBCS notation.
 *
 * @param scale The document's `numberConvention.scale`, for the TITLE, the
 *   bar labels and the y-axis. The bridge's own `start`/`end` figures stay
 *   raw — the integrity gate walks them, and scaling a model figure would
 *   put a display transform where a check reads.
 */
export function buildProfitWaterfallChart(set: PackFigureSet, scale: MoneyScale): PackChartSpec {
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
  const bridged = withUncapturedStep(steps, f.netProfit);
  return {
    id: 'profit-bridge',
    title: `Revenue of ${formatMoney(f.revenue, { scale })} bridges to net profit of ${formatMoney(f.netProfit, { scale })}.`,
    kind: 'waterfall',
    svg: renderChartSvg(waterfallOption(bridged, scale), FULL),
    heightMm: FULL.heightMm,
    waterfallBars: toBars(bridged, PROFIT_UNCAPTURED_LABEL),
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
export const CASH_UNCAPTURED_LABEL = 'Unexplained movement';

export interface PackCashBridge {
  chart: PackChartSpec;
  /** The movement in cash the three captured categories do not account for.
   *  Drawn as its own named bar, and the page must say what it is. */
  residual: number;
}

export function buildCashWaterfallChart(set: PackFigureSet, scale: MoneyScale): PackCashBridge | null {
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
  if (residual !== 0) movements.push({ label: CASH_UNCAPTURED_LABEL, value: residual });

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
      title: `Cash moved from ${formatMoney(opening, { scale })} to ${formatMoney(current.cash, { scale })} over the period.`,
      kind: 'waterfall',
      svg: renderChartSvg(waterfallOption(steps, scale), HALF),
      heightMm: HALF.heightMm,
      waterfallBars: toBars(steps, CASH_UNCAPTURED_LABEL),
    },
  };
}

/** Page 7 — assets beside the funding that stands behind them, per period. */
export function buildPositionCompositionChart(set: PackFigureSet, scale: MoneyScale): PackChartSpec {
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
    title: `Assets of ${formatMoney(current.totalAssets, { scale })} stand on liabilities of ${formatMoney(current.totalLiabilities, { scale })} and equity of ${formatMoney(current.totalEquity, { scale })}.`,
    kind: 'bar',
    svg: renderChartSvg(compositionBarOption(periods, series, scale), FULL),
    heightMm: FULL.heightMm,
  };
}

