/**
 * Page 8's cash bridge, or the statement that there is not one. Split out of
 * `packPageCharts.ts` for the 300-line cap; that file re-exports every
 * export here, so each caller still imports it there.
 */
import { svgBoxFor } from './packChartBox';
import { formatMoney, inProse, type MoneyScale } from '@/lib/format/money';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import { waterfallOption } from '@/modules/accounting/services/packs/packChartOptions';
import { MONEY_TOLERANCE } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { investingCashFlowOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { HALF } from './packChartRungs';
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
