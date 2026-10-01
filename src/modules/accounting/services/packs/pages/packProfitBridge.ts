/**
 * Page 6's profit bridge — revenue to net profit with its named plug, and
 * the same bridge a rung shorter or grown back into the paper. Split out of
 * `packPageCharts.ts` for the 300-line cap; that file re-exports every
 * export here, so each caller still imports it there.
 */
import { svgBoxFor } from './packChartBox';
import { formatMoney, inProse, type MoneyScale } from '@/lib/format/money';
import { buildProfitWaterfall, OPERATING_PROFIT_BAR, type WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import { waterfallOption } from '@/modules/accounting/services/packs/packChartOptions';
import {
  MONEY_TOLERANCE,
  UNCAPTURED_SHARE_LIMIT,
  uncapturedShare,
} from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { BRIDGE_RUNGS, CHART_MEASURE_MM, FULL, MID, type ChartBox } from './packChartRungs';
import { intervalsFor, isCompact, PX_PER_MM, toBars } from './packWaterfallBars';
import type { PackChartSpec } from './packPageModel';

/**
 * THE SAME BRIDGE ONE RUNG SHORTER, or null at the bottom of the grid.
 *
 * `buildProfitWaterfallChart` predicts what else the page will carry — a plug
 * disclosure, a negative-revenue disclosure, the trends cross-reference
 * footnote — and steps down one rung where it does. Three times that
 * prediction has been a rung short of the page it was predicting, and the
 * third time the page could not be composed at all: live Brightsphere carries
 * the negative-revenue disclosure AND a required sign-flip footnote AND a
 * three-line "no comparable percentage change" caption, and at 72mm its
 * income statement measures 260.5mm in a 255mm box with nothing left on it
 * the fitter may drop.
 *
 * So the caller MEASURES instead of predicting further: it composes the page,
 * and where the page still does not fit it asks for the next rung down and
 * composes it again — see `boardPackPages`. A predicate that enumerates
 * causes is wrong on the fourth cause; a page that has been measured is not.
 * The predicates above stay as the STARTING rung, so no page that fits today
 * changes height.
 *
 * The bottom rung is 48mm, which is where page 8 already draws its cash
 * bridge — the same chart kind at the same size in the same pack — and
 * `intervalsFor` drops the bridge to three gridlines there rather than
 * crowding six into the plot.
 */
export function shorterProfitBridge(
  set: PackFigureSet,
  scale: MoneyScale,
  current: PackChartSpec,
): PackChartSpec | null {
  const rung = BRIDGE_RUNGS.findIndex((b) => b.heightMm === current.heightMm);
  const next = rung === -1 ? undefined : BRIDGE_RUNGS[rung + 1];
  return next === undefined ? null : buildProfitWaterfallChart(set, scale, false, next);
}

/**
 * THE BRIDGE GROWN BACK INTO THE PAPER THE LADDER OVERSHOT.
 *
 * `shorterProfitBridge` steps down a fixed ladder — 110mm, 72, 48 — and the
 * steps are 24 and 38mm apart while the decision they answer is measured in
 * tenths. Live Brightsphere's income statement is the case: at the 72mm rung
 * the sheet composes 0.2mm past its box, so the loop takes the next rung and
 * the page prints a 48mm bridge with 23.8mm of paper under it. A quarter of
 * the sheet is white because the chart missed by a fifth of a millimetre, and
 * the demo renders the same chart at 72.
 *
 * The ladder is right for CHOOSING — a page that does not fit must give
 * something back, and the chart is the one thing on it with a height the spec
 * lets us pick. What it is wrong for is STOPPING: nothing says the height has
 * to be one of three. This returns the same bridge at whatever height the
 * page actually has room for, capped at the tallest rung, so the ladder
 * decides the rung and the paper decides the last few millimetres.
 *
 * Null when there is nothing worth growing into — the caller keeps the chart
 * it has rather than re-rendering an SVG for half a millimetre.
 */
export function profitBridgeAtHeight(
  set: PackFigureSet,
  scale: MoneyScale,
  carriesWindowNote: boolean,
  heightMm: number,
): PackChartSpec | null {
  // WHOLE MILLIMETRES. The spare is a difference of two measured heights and
  // carries a tail of fifteen decimal places; a chart box that renders at
  // 103.38166666666666mm makes every diff of this pack look like a change.
  const target = Math.floor(Math.min(CHART_HEIGHT_MM.full, heightMm));
  if (target <= 0) return null;
  return buildProfitWaterfallChart(set, scale, carriesWindowNote,
    { widthMm: CHART_MEASURE_MM, heightMm: target });
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
  // A CENT, NOT ZERO. This is a difference of floats: a bridge that foots
  // exactly in decimal leaves a few hundred-billionths here, and `=== 0` drew
  // that as a zero-height bar labelled as income the pack did not capture.
  if (Math.abs(gap) <= MONEY_TOLERANCE) return steps;

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
 * @param carriesWindowNote Whether the page also carries the trends
 *   cross-reference footnote — see `crowded` below.
 * @param rung The height to draw it at, overriding the one the predicates
 *   below choose. `shorterProfitBridge` passes it; nothing else should.
 */
export function buildProfitWaterfallChart(
  set: PackFigureSet,
  scale: MoneyScale,
  carriesWindowNote = false,
  rung?: ChartBox,
): PackChartSpec {
  const f = set.current;
  // WHICH LINES THE BRIDGE LEFT OUT COMES BACK WITH THE BRIDGE, so page 6
  // names what the builder actually dropped. This page used to derive the
  // list itself, from the statement figures below, with its own `=== 0`
  // predicate — a second implementation of the builder's rule that agreed
  // with it by coincidence, and that could not name the Operating Profit
  // subtotal at all because its list was of the five movement lines.
  const { steps, omitted } = buildProfitWaterfall({
    revenue: f.revenue,
    costOfSales: f.costOfSales,
    grossProfit: f.revenue - f.costOfSales,
    operatingExpenses: f.operatingExpenses,
    otherIncome: f.otherIncome ?? 0,
    otherExpenses: f.otherExpenses ?? 0,
    netProfit: f.netProfit,
    // The figure page 6's TABLE prints on its Operating profit row, so the
    // bridge draws that subtotal only where its own walk lands on the same
    // number — see the step in `buildProfitWaterfall`.
    operatingProfit: operatingProfitOf(f),
  });
  const bridged = withUncapturedStep(steps, f.netProfit);
  const bars = toBars(bridged, PROFIT_UNCAPTURED_LABEL, 'belowTheOperatingLine');
  // AND THE SAME RULE AS PAGE 7: the chart gives a rung back when the page
  // has something to say. Where the plug breaches `UNCAPTURED_SHARE_LIMIT`
  // this page must also carry the unexplained-step disclosure, and on the
  // dense fixture it carried the disclosure, a full-height bridge, a table
  // and three footnotes — 262.2mm in a 255mm box, so the income statement
  // printed on two sheets. The step-down is conditional on the same test the
  // disclosure is, so the height is given back exactly when it is needed.
  //
  // NEGATIVE REVENUE BUYS THE SAME RUNG, for the same reason. A company whose
  // turnover is below zero must carry the "what this means" disclosure page 7
  // already gives a negative asset side, and Brightsphere's income statement
  // measured 244.8mm in a 255mm box before it — so the page refused rather
  // than printing the callout. The disclosure costs ~28mm and a rung gives
  // back 38.
  //
  // AND A FOURTH FOOTNOTE BUYS IT TOO, WHICH IS THE CASE THAT WAS MISSING.
  // On the live demo company the page carries neither disclosure and still
  // came to 255.83mm in a 255mm box — eight tenths of a millimetre — once the
  // trends cross-reference footnote landed on it, so `fitPageToBox` dropped
  // that footnote AND the prior-column basis and printed "Not printed on this
  // page: 2 footnotes" to a board. Nothing shorter than a rung closes it: the
  // two footnotes that could be trimmed both say something the page needs,
  // and the sheet has no optional prose at all. The cross-reference footnote
  // only exists where the trends page draws a gross-margin panel, so this is
  // the same conditional shape as the two above — the chart gives a rung back
  // exactly where the page has something more to say.
  const share = uncapturedShare(bars);
  // A LINE BELOW ZERO BUYS THE RUNG, NOT A REVENUE BELOW ZERO.
  //
  // This read `f.revenue < 0` while the sheet's sign disclosure fired on any
  // income or cost line the wrong side of zero — so a company with positive
  // turnover and three negative cost lines got the disclosure AND the tallest
  // bridge, and page 6 refused to compose at 258.4mm in a 255mm box. The
  // predicate and the block it pays for read the same condition now.
  const signCaveat = [f.revenue, f.costOfSales, f.operatingExpenses, f.otherIncome ?? 0, f.otherExpenses ?? 0]
    .some((line) => line < 0);
  // AND A REFUSED SUBTOTAL BUYS THE RUNG, for the same reason as the other
  // three. Where the walk and the classifier's operating profit disagree the
  // bar is not drawn and `bridgeSignFootnote` must say so in its own words —
  // a required footnote, on a sheet that measured 261.2mm in a 255mm box with
  // it and nothing droppable left, so the page refused to compose at all.
  // The disclosure costs a footnote line; a rung gives back 38mm. Same
  // conditional shape as the three above: the chart gives the height back
  // exactly where the page has something more to say.
  const crowded = (share !== null && share >= UNCAPTURED_SHARE_LIMIT)
    || signCaveat
    || carriesWindowNote
    || omitted.includes(OPERATING_PROFIT_BAR);
  const box = rung ?? (crowded ? MID : FULL);
  // HOISTED, because the SVG has to be rendered at the box the FIGURE will
  // give it and that depends on how tall this sentence wraps — see
  // `svgBoxFor`.
  const bridgeTitle = `Revenue of ${inProse(formatMoney(f.revenue, { scale }))} bridges to net `
    + `profit of ${inProse(formatMoney(f.netProfit, { scale }))}.`;
  const plot = svgBoxFor(box, bridgeTitle);
  // WHICH BARS THE RENDERER HAD TO FLOOR, collected as it draws them — see
  // `PackChartSpec.flooredBars`. A Set because ECharts may call `renderItem`
  // more than once for a datum, and the sheet names each bar once.
  const floored = new Set<string>();
  const svg = renderChartSvg(
    waterfallOption(bridged, scale, undefined, intervalsFor(box), isCompact(box), (label) => floored.add(label),
      plot.heightMm * PX_PER_MM),
    plot,
  );
  return {
    id: 'profit-bridge',
    title: bridgeTitle,
    kind: 'waterfall',
    svg,
    heightMm: box.heightMm,
    plotMm: plot.heightMm,
    waterfallBars: bars,
    omittedBars: omitted,
    // In the order the walk reaches them, not the order the renderer happened
    // to draw them, so the sentence reads down the bridge like the omission
    // one beside it.
    flooredBars: bars.map((bar) => bar.label).filter((label) => floored.has(label)),
  };
}
