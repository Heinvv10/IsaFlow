/**
 * Page 7's composition chart — assets beside the funding behind them — its
 * title, and the same chart at the height its sheet has left. Split out of
 * `packPageCharts.ts` for the 300-line cap; that file re-exports every
 * export here, so each caller still imports it there.
 */
import { svgBoxFor } from './packChartBox';
import { formatMoney, inProse, type MoneyScale } from '@/lib/format/money';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import {
  COMPOSITION_CHROME_PX,
  compositionBarOption,
  type CompositionSeries,
} from '@/modules/accounting/services/packs/packChartOptions';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { CHART_MEASURE_MM, MID, type ChartBox } from './packChartRungs';
import { PX_PER_MM } from './packWaterfallBars';
import { TICK_PITCH_PX } from '@/modules/accounting/services/packs/packWaterfallDomain';
import type { PackChartSpec } from './packPageModel';

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

/**
 * HOW MANY GRIDLINE STEPS THE PLOT HAS ROOM FOR, from its own height.
 *
 * ECharts chose the ticks, and it chooses by the data: 4 000 down to (5 000)
 * at every 1 000 is ten labels whatever the box. At the middle rung they
 * stood 16px apart in 12px type and at the 65mm the live sheets shorten this
 * chart to, 13 — labels touching. The ask is the bridges' own target pitch
 * (`TICK_PITCH_PX`, 26px a step), so a shorter chart draws FEWER ticks rather
 * than the same ticks closer together. `axisDomain` may round the bounds out
 * by a step, which is why the target is above the 18px legibility floor the
 * gate holds every chart to.
 */

function tickIntervals(plotMm: number): number {
  const plotPx = plotMm * PX_PER_MM - COMPOSITION_CHROME_PX.top - COMPOSITION_CHROME_PX.bottom;
  return Math.max(2, Math.floor(plotPx / TICK_PITCH_PX));
}

/** Page 7 — assets beside the funding that stands behind them, per period. */
export function buildPositionCompositionChart(
  set: PackFigureSet,
  scale: MoneyScale,
  box: ChartBox = MID,
): PackChartSpec {
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
  //
  // `box` is MID unless the page MEASURED itself short — see
  // `positionCompositionChartAtHeight`.
  const compositionTitle = positionCompositionTitle(current, scale);
  const compositionPlot = svgBoxFor(box, compositionTitle);

  return {
    id: 'position-composition',
    title: compositionTitle,
    kind: 'bar',
    svg: renderChartSvg(
      compositionBarOption(periods, series, scale, undefined, tickIntervals(compositionPlot.heightMm)),
      compositionPlot,
    ),
    heightMm: box.heightMm,
    plotMm: compositionPlot.heightMm,
  };
}

/**
 * The shortest the composition chart is drawn. Below this its y-axis ticks
 * close up toward the overprinting the bottom rung had — 48mm is where
 * `(1 000)`, `(2 000)` and `(3 000)` printed on top of one another, and at
 * 60mm the live demo company's ticks are still 10.9px apart at 12px type.
 * Held by `packChartAxisLegibility.test.ts`, at this height.
 */
export const POSITION_CHART_FLOOR_MM = 63;

/**
 * PAGE 7'S CHART AT THE HEIGHT ITS SHEET HAS LEFT, or null where that is
 * under the floor.
 *
 * `profitBridgeAtHeight`'s construction, in the other direction: the middle
 * rung is the starting height and the paper decides the last few millimetres.
 * Whole millimetres, for the reason given there.
 */
export function positionCompositionChartAtHeight(
  set: PackFigureSet,
  scale: MoneyScale,
  heightMm: number,
): PackChartSpec | null {
  const target = Math.floor(Math.min(MID.heightMm, heightMm));
  if (target < POSITION_CHART_FLOOR_MM) return null;
  return buildPositionCompositionChart(set, scale, { widthMm: CHART_MEASURE_MM, heightMm: target });
}
