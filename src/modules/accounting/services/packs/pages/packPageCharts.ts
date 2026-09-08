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

import { PAGE_WIDTH_MM } from './packTextMetrics';
import { svgBoxFor } from './packChartBox';
import { formatMoney, inProse, type MoneyScale } from '@/lib/format/money';
import { buildProfitWaterfall, type WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import {
  compositionBarOption,
  stepPaint,
  waterfallOption,
  waterfallChromePx,
  type CompositionSeries,
} from '@/modules/accounting/services/packs/packChartOptions';
import {
  UNCAPTURED_SHARE_LIMIT,
  uncapturedShare,
} from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackChartSpec, PackWaterfallBar, PlugReason } from './packPageModel';

/** Page 10's panels and page 8's cash line, re-exported so every existing
 *  `packPageCharts` import path still resolves after the split. */
export {
  buildCashTrendChart,
  shorterCashTrendChart,
  buildTrendPanels,
  TRENDS_PANELS_SPECIFIED,
} from './packTrendCharts';
export type { TrendPanels } from './packTrendCharts';

/**
 * THE CHART MEASURE IS THE TABLE MEASURE.
 *
 * Every box here was 170mm against a text measure of 174, so no chart in the
 * pack sat on the grid its own page's tables sit on — a 2mm step down each
 * side, invisible in isolation and plain in a stack. The gate measured the
 * consequence at the plot rather than the box: three different chart measures
 * on one document, none of them the table's, none centred on it.
 *
 * `PAGE_WIDTH_MM.portrait` rather than a literal, so the two cannot drift:
 * the tables take the same constant through `packMattersColumns` and
 * `packScorecardColumns`.
 */
const CHART_MEASURE_MM = PAGE_WIDTH_MM.portrait;

const FULL = { widthMm: CHART_MEASURE_MM, heightMm: CHART_HEIGHT_MM.full };

/**
 * Page 8's bridge is the INLINE rung, not half and not full.
 *
 * Its page is the busiest in the pack — a cash table, this bridge, a
 * multi-period cash line and up to two disclosures — and at full height it
 * was 60mm taller than an A4 content box, so it printed on two sheets with
 * the closing-cash chart stranded alone on the second. Half height was still
 * 17mm too tall once the page titles became visible on paper (they had been
 * hidden by a `header` rule in styles/print.css), and on the live demo
 * company, whose cash table carries four footnotes, 35mm too tall. Spec
 * §5.6's height grid is 48/72/110mm and this is the bottom rung — the same
 * rung the closing-cash line beside it already uses, so the two charts on
 * the page are now the same height as each other. Nothing is dropped from
 * the page to buy the space.
 */
const HALF = { widthMm: CHART_MEASURE_MM, heightMm: CHART_HEIGHT_MM.inline };

/**
 * Spec §5.6's MIDDLE rung, which is what page 7 steps down to.
 *
 * It stepped down to `HALF` — the bottom rung, 48mm — to make room for the
 * negative-assets disclosure, and the callout is right, but at 48mm the
 * composition chart's plot band is about 77px for a 3 000 to (4 000) range
 * and `(1 000)`, `(2 000)` and `(3 000)` printed ON TOP OF ONE ANOTHER.
 * Overlapping axis labels are the visual signature of an unfinished chart,
 * and the room was never needed from the chart: the sheet still ended with
 * ~36mm of white below the last disclosure. 72mm spends 24 of those 36 and
 * leaves the axis 168px to put eight ticks in.
 */
const MID = { widthMm: CHART_MEASURE_MM, heightMm: CHART_HEIGHT_MM.half };

type ChartBox = { widthMm: number; heightMm: number };

/** Spec §5.6's height grid, tallest first — the only heights a bridge takes. */
const BRIDGE_RUNGS: ChartBox[] = [FULL, MID, HALF];

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
 * HOW MANY GRIDLINE STEPS THIS BOX HAS ROOM FOR.
 *
 * `waterfallOption` defaults to six, which suits the 110mm rung and
 * overprints on the 48mm one: the demo cash bridge drew seven tick labels
 * with 11.8px between their centres at 12px type. The plot is the box less
 * `grid.top` and `grid.bottom`, which `waterfallChromePx` reports because
 * the bottom rung draws them tighter, and 26px is
 * comfortable for a 12px label — the same measure `packChartAxisLegibility`
 * asserts against on the printed SVG.
 */
const PX_PER_MM = 96 / 25.4;
const TICK_PITCH_PX = 26;

/** The bottom rung, where the bridge draws its axis chrome tighter and its
 *  category labels a size smaller — see `WATERFALL_CHROME`. */
function isCompact(box: { heightMm: number }): boolean {
  return box.heightMm <= CHART_HEIGHT_MM.inline;
}

function intervalsFor(box: { heightMm: number }): number {
  const plot = box.heightMm * PX_PER_MM - waterfallChromePx(isCompact(box));
  return Math.max(2, Math.floor(plot / TICK_PITCH_PX));
}

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
function toBars(
  steps: WaterfallStep[],
  uncapturedLabel: string | null,
  /** WHY that step exists, carried onto the bar — the two bridges plug for
   *  different reasons and the sentence that explains one is false of the
   *  other. Required alongside the label, so a plug cannot be marked without
   *  one. See `PlugReason`. */
  uncapturedReason: PlugReason,
): PackWaterfallBar[] {
  return steps.map((step, index) => {
    const paint = stepPaint(step);
    return {
      label: step.label,
      start: step.start,
      end: step.end,
      kind: barKind(step, index, steps.length),
      ...(step.label === uncapturedLabel ? { uncaptured: uncapturedReason } : {}),
      ...(paint === null ? {} : { paint }),
    };
  });
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
 * @param carriesWindowNote Whether the page also carries the trends
 *   cross-reference footnote — see `crowded` below.
 * @param rung The height to draw it at, overriding the one the predicates
 *   below choose. `shorterProfitBridge` passes it; nothing else should.
 */
/**
 * WHICH LINES THE BRIDGE LEFT OUT, so page 6 can name them.
 *
 * `buildProfitWaterfall` applies the rule — a nil movement is not drawn,
 * subtotals stay — and this is the other half: a rule a sheet does not state
 * is a rule a reader cannot check, and a reader comparing two packs, or one
 * pack against the table three centimetres above the bridge, cannot tell an
 * omitted line from an absent one.
 *
 * DERIVED FROM THE STATEMENT LINES, NOT FROM THE STEPS THAT CAME BACK. The
 * builder does not report what it dropped and the drawn steps cannot say
 * either, so reading the omissions off them names only the lines that
 * happened to survive an earlier gate. This takes the figures the chart was
 * built FROM, which is the only place the answer is complete.
 */
function omittedLines(lines: Array<[string, number]>): string[] {
  return lines.filter(([, value]) => value === 0).map(([label]) => label);
}

export function buildProfitWaterfallChart(
  set: PackFigureSet,
  scale: MoneyScale,
  carriesWindowNote = false,
  rung?: ChartBox,
): PackChartSpec {
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
  const omitted = omittedLines([
    ['Revenue', f.revenue],
    ['Cost of Sales', f.costOfSales],
    ['Operating Expenses', f.operatingExpenses],
    ['Other Income', f.otherIncome ?? 0],
    ['Other Expenses', f.otherExpenses ?? 0],
  ]);
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
  const crowded = (share !== null && share >= UNCAPTURED_SHARE_LIMIT)
    || signCaveat
    || carriesWindowNote;
  const box = rung ?? (crowded ? MID : FULL);
  // HOISTED, because the SVG has to be rendered at the box the FIGURE will
  // give it and that depends on how tall this sentence wraps — see
  // `svgBoxFor`.
  const bridgeTitle = `Revenue of ${inProse(formatMoney(f.revenue, { scale }))} bridges to net `
    + `profit of ${inProse(formatMoney(f.netProfit, { scale }))}.`;
  const plot = svgBoxFor(box, bridgeTitle);
  return {
    id: 'profit-bridge',
    title: bridgeTitle,
    kind: 'waterfall',
    svg: renderChartSvg(waterfallOption(bridged, scale, undefined, intervalsFor(box), isCompact(box)), plot),
    heightMm: box.heightMm,
    plotMm: plot.heightMm,
    waterfallBars: bars,
    omittedBars: omitted,
  };
}

/**
 * Page 8 — the cash bridge, OR THE STATEMENT THAT THERE IS NOT ONE.
 *
 * A BRIDGE WHOSE ONLY STEP IS A PLUG IS NOT A BRIDGE. The pack's figure set
 * carries the period's cash totals; the operating, investing and financing
 * splits a cash flow statement is made of are separate captures, and most
 * companies here have none of them. Where that is so this used to draw three
 * bars — opening, a single red step named "Unexplained movement" at 100% of
 * the movement, and closing — under a heading calling it a bridge. Cash is
 * the first page many directors turn to, and it said, in the largest object
 * on the sheet, that the company could not account for its own cash. The
 * accompanying sentence was honest about why, and being honest about a
 * picture that should not have been drawn is not the same as not drawing it.
 *
 * The chart also cost more than it carried: 48mm of sheet, a squeezed plot
 * with touching axis labels, to restate the two figures the table three
 * centimetres above it already prints under ACTUAL and PRIOR, plus a
 * difference it prints under CHANGE. Nothing is lost by omitting it and the
 * page gets the room back — which is where page 8's dropped prose was going
 * to come from.
 *
 * SO THE BRIDGE IS DRAWN WHEN THERE IS SOMETHING TO DECOMPOSE — at least one
 * captured cash-flow category — and otherwise the page states the movement
 * in words and says which figures would be needed to break it down. Where a
 * category IS captured the residual is still drawn as its own named step,
 * because a bridge that silently failed to reach its own closing bar would
 * contradict the table above it.
 *
 * Opening cash is the prior period's closing balance, so a company with no
 * prior period has no bridge either, and opening a bar at zero would assert
 * the business started the period with an empty bank account.
 */
export const CASH_UNCAPTURED_LABEL = 'Unexplained movement';

/**
 * Either the drawn bridge, or why the page does not carry one.
 *
 * `why` is READER COPY, not a diagnostic: it is printed on the sheet as a
 * required disclosure, so it says what the movement was and what is missing
 * rather than which branch the composer took.
 */
export type PackCashBridge =
  | {
      drawn: true;
      chart: PackChartSpec;
      /** The movement in cash the captured categories do not account for.
       *  Drawn as its own named bar, and the page must say what it is. */
      residual: number;
    }
  | { drawn: false; why: string };

export function buildCashWaterfallChart(set: PackFigureSet, scale: MoneyScale): PackCashBridge {
  const { current, prior } = set;
  if (prior === null) {
    return {
      drawn: false,
      // STRAIGHT APOSTROPHES, LIKE THE REST OF THE PACK. This sentence and
      // the two below carried curly ones — three of them against forty-eight
      // straight ones on the same sheet, `R'000` among them — so page 8
      // printed two apostrophes in one paragraph. Escaped rather than
      // rewritten around: the wording is not what was wrong.
      why: 'Opening cash is the prior period\'s closing balance, and there is no prior '
        + 'period. A bridge opening at zero would assert the business started the period with '
        + 'an empty bank account.',
    };
  }

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

  if (movements.length === 0) {
    const movement = current.cash - opening;
    return {
      drawn: false,
      why: `Cash moved ${inProse(formatMoney(opening, { scale }))} to ${inProse(formatMoney(current.cash, { scale }))} `
        + `over the period, a movement of ${inProse(formatMoney(movement, { scale }))}. No bridge is drawn `
        + 'because there is nothing to bridge THROUGH: this pack\'s figure set carries the '
        + 'period\'s cash totals and none of the operating, investing or financing figures a '
        + 'cash flow statement is made of, so every step between the two balances would be one '
        + 'unmeasured step the width of the whole movement. Ask for the cash flow statement for '
        + 'the split.',
    };
  }

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

  const cashBridgeTitle = `Cash moved from ${inProse(formatMoney(opening, { scale }))} to `
    + `${inProse(formatMoney(current.cash, { scale }))} over the period.`;
  const cashBridgePlot = svgBoxFor(HALF, cashBridgeTitle);
  return {
    drawn: true,
    residual,
    chart: {
      id: 'cash-bridge',
      title: cashBridgeTitle,
      kind: 'waterfall',
      svg: renderChartSvg(waterfallOption(steps, scale, undefined, intervalsFor(HALF), isCompact(HALF)), cashBridgePlot),
      heightMm: HALF.heightMm,
      plotMm: cashBridgePlot.heightMm,
      waterfallBars: toBars(steps, CASH_UNCAPTURED_LABEL, 'cashFlowSplits'),
    },
  };
}

/**
 * PAGE 7'S CHART TITLE, WHICH USED TO BE A METAPHOR THAT COLLAPSES ON THE
 * ONE COMPANY THAT NEEDS IT MOST.
 *
 * It read "Assets of (730) stand on liabilities of 3 357 and equity of
 * (4 087)". Nothing stands on anything when the asset side is negative: the
 * sentence asks a director to picture a structure at the exact moment the
 * pack is telling them there is not one, on the sheet where the figures are
 * least forgiving of a loose word. The demo pack and Brightsphere both print
 * negative assets, so this is not a hypothetical edge.
 *
 * A structural verb where the structure holds, the balance-sheet identity in
 * plain words where it does not — "matched by" is true of A = L + E at any
 * sign, and claims no shape. "Does not hold" is ANY component below zero,
 * not just assets: equity of (4 087) does not stand under anything either.
 */
function positionCompositionTitle(current: PackFigureSet['current'], scale: MoneyScale): string {
  // `inProse`: this is a SENTENCE, and a nil asset side or nil equity is
  // ordinary. A raw dash here refuses the whole pack — see `money` in
  // `derivedSentences.ts`.
  const money = (n: number) => inProse(formatMoney(n, { scale }));
  const funding = `liabilities of ${money(current.totalLiabilities)} and equity of ${money(current.totalEquity)}`;
  const structural = current.totalAssets >= 0
    && current.totalLiabilities >= 0
    && current.totalEquity >= 0;
  return structural
    ? `Assets of ${money(current.totalAssets)} stand on ${funding}.`
    : `Assets of ${money(current.totalAssets)} are matched by ${funding}.`;
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

  // THE CHART GIVES THE HEIGHT BACK WHEN THE PAGE HAS SOMETHING TO SAY —
  // ONE RUNG, NOT TWO.
  //
  // Page 7 measured 253.6mm in a 255mm box on the live company — 1.4mm of
  // slack — so the negative-assets disclosure it must carry had nowhere to
  // go. Spec §5.6's rungs exist for exactly this, and page 8's cash line
  // already steps down for the same reason. But the first fix took the chart
  // all the way to the bottom rung and the y-axis stopped being legible:
  // three of its tick labels overprinted each other. The disclosure costs
  // ~28mm and the sheet had ~36mm of white left under it, so the middle rung
  // pays for the callout and keeps the axis readable. Measured on the printed
  // sheet, not on the model — `packChartAxisLegibility.test.ts`.
  //
  // AND IT IS NOW THE MIDDLE RUNG ON EVERY COMPANY, because the page always
  // has something to say: `tradeBalancesFootnote` prints the two balances
  // the day counts are taken on, and page 7 is where a reader looks for
  // them. It was `totalAssets < 0 ? MID : FULL`, which left the live
  // Brightsphere sheet — positive assets, one required disclosure — at the
  // full rung with 2.73mm of slack, not enough for a footnote line. At MID
  // it composes with room, the demo sheet is unchanged (its assets are
  // negative, so it was already here), and the two companies' balance sheets
  // are the same shape rather than two heights decided by the sign of one
  // figure.
  const box = MID;
  const compositionTitle = positionCompositionTitle(current, scale);
  const compositionPlot = svgBoxFor(box, compositionTitle);

  return {
    id: 'position-composition',
    title: compositionTitle,
    kind: 'bar',
    svg: renderChartSvg(compositionBarOption(periods, series, scale), compositionPlot),
    heightMm: box.heightMm,
    plotMm: compositionPlot.heightMm,
  };
}

