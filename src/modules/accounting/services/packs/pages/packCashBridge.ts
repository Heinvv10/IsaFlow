/**
 * Page 8's cash bridge, or the statement that there is not one. Split out of
 * `packPageCharts.ts` for the 300-line cap; that file re-exports every
 * export here, so each caller still imports it there.
 */
import { svgBoxFor, svgBoxPx } from './packChartBox';
import { formatMoney, inProse, type MoneyScale } from '@/lib/format/money';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import { waterfallOption } from '@/modules/accounting/services/packs/packChartOptions';
import { waterfallDrawnSize } from '@/modules/accounting/services/packs/packWaterfallFrame';
import { axisDomain } from '@/modules/accounting/services/packs/packChartAxes';
import { MONEY_TOLERANCE } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { investingCashFlowOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { CHART_MEASURE_MM, grownHeightMm, HALF, type ChartBox, type DrawnSize } from './packChartRungs';
import { intervalsFor, isCompact, toBars } from './packWaterfallBars';
import type { PackChartSpec } from './packPageModel';

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

/**
 * HOW MANY GRIDLINE STEPS TO ASK FOR, so the axis draws no more than the plot
 * has room for.
 *
 * `axisDomain` takes the round step NEAREST the rough one, so it can round
 * down, and rounding the bounds out then adds a step at either end: asked for
 * four, the demo's bridge drew six — (100) to (600), 13px apart. The ask is
 * lowered until the drawn count fits. Here rather than in `axisDomain`, whose
 * other callers' gridlines the sheets' strike and label tests are built on.
 */
function cashBridgeIntervals(steps: WaterfallStep[], box: { heightMm: number }, plotMm: number): number {
  const room = intervalsFor(box, plotMm);
  const values = steps.flatMap((step) => [step.start, step.end]);
  let asked = room;
  while (asked > 1 && axisDomain(values, asked).splitNumber > room) asked -= 1;
  return asked;
}

/** The bridge's steps and its residual, or why there is no bridge. */
function cashBridgeSteps(
  set: PackFigureSet, scale: MoneyScale,
): { drawn: false; why: string } | { drawn: true; steps: WaterfallStep[]; residual: number; opening: number } {
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
  // said no investing figure was captured — the same figure telling two
  // stories on one page. An uncaptured category is absorbed by the named
  // residual below, which is honest about not knowing.
  //
  // Investing is the SAME reading the table's row takes — the cash flow
  // statement's net figure, or capital expenditure negated where the pack
  // has only that — see `investingCashFlowOf`.
  const movements: Array<{ label: string; value: number }> = [];
  if (current.operatingCashFlow !== undefined) movements.push({ label: 'Operating', value: current.operatingCashFlow });
  const investing = investingCashFlowOf(current);
  if (investing !== null) movements.push({ label: 'Investing', value: investing });
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
  // Under a cent is float residue, not a movement — see `withUncapturedStep`.
  // Zeroed here rather than only skipped, because the page's caption and its
  // disclosure both read `residual` and neither should explain a rounding.
  const difference = current.cash - opening - explained;
  const residual = Math.abs(difference) <= MONEY_TOLERANCE ? 0 : difference;
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

  return { drawn: true, steps, residual, opening };
}

export function buildCashWaterfallChart(
  set: PackFigureSet,
  scale: MoneyScale,
  /** HALF unless page 8 measured itself with room to spare — see
   *  `buildCashSheet`. */
  box: { widthMm: number; heightMm: number } = HALF,
): PackCashBridge {
  const walk = cashBridgeSteps(set, scale);
  if (!walk.drawn) return walk;
  const { steps, residual, opening } = walk;
  const { current } = set;
  const { title: cashBridgeTitle, plot: cashBridgePlot, intervals } = cashFrame(steps, opening, current.cash, scale, box);
  const chart: PackChartSpec = {
    id: 'cash-bridge',
    title: cashBridgeTitle,
    kind: 'waterfall',
    svg: renderChartSvg(waterfallOption(
      steps, scale, undefined, intervals, isCompact(box), undefined, svgBoxPx(cashBridgePlot),
    ), cashBridgePlot),
    heightMm: box.heightMm,
    plotMm: cashBridgePlot.heightMm,
    waterfallBars: toBars(steps, CASH_UNCAPTURED_LABEL, 'cashFlowSplits'),
  };
  return { drawn: true, residual, chart };
}

/** The title, the box it leaves the chart and the axis's ask, for `box`. */
function cashFrame(steps: WaterfallStep[], opening: number, closing: number, scale: MoneyScale, box: ChartBox) {
  const title = `Cash moved from ${inProse(formatMoney(opening, { scale }))} to `
    + `${inProse(formatMoney(closing, { scale }))} over the period.`;
  const plot = svgBoxFor(box, title);
  return { title, plot, intervals: cashBridgeIntervals(steps, box, plot.heightMm) };
}

/**
 * THE CASH BRIDGE AT THE BIGGEST PICTURE THE ROOM HOLDS. Page 8 grows its
 * bridge into whatever the sheet has left: every height from the one it has
 * to the room is laid out and the one with the tallest bar is drawn — see
 * `grownHeightMm`. A taller box once redrew the axis coarser and the tallest
 * bar went from 99.1px to 70.7px with a millimetre more room. Null where the
 * chart the page has is already the best, and the caller keeps it.
 */
export function cashBridgeAtHeight(
  set: PackFigureSet, scale: MoneyScale, heightMm: number, current: PackCashBridge,
): (PackCashBridge & { drawn: true }) | null {
  const walk = cashBridgeSteps(set, scale);
  if (!current.drawn || !walk.drawn) return null;
  const { steps, opening } = walk;
  const sizeAt = (mm: number): DrawnSize => {
    const box = { widthMm: CHART_MEASURE_MM, heightMm: mm };
    const { plot, intervals } = cashFrame(steps, opening, set.current.cash, scale, box);
    return waterfallDrawnSize(steps, scale, intervals, isCompact(box), svgBoxPx(plot));
  };
  const best = grownHeightMm(current.chart.heightMm, heightMm, sizeAt);
  if (best === current.chart.heightMm) return null;
  const grown = buildCashWaterfallChart(set, scale, { widthMm: CHART_MEASURE_MM, heightMm: best });
  return grown.drawn ? grown : null;
}
