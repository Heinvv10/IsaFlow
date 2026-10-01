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

/** Page 10's panels and page 8's cash line, re-exported so every existing
 *  `packPageCharts` import path still resolves after the split. */
export {
  buildCashTrendChart,
  shorterCashTrendChart,
  buildTrendPanels,
  TRENDS_PANELS_SPECIFIED,
} from './packTrendCharts';
export type { TrendPanels } from './packTrendCharts';

/** The two bridges and page 7's composition chart, each split to its own
 *  module for the 300-line cap and re-exported for the same reason. */
export {
  shorterProfitBridge,
  profitBridgeAtHeight,
  PROFIT_UNCAPTURED_LABEL,
  buildProfitWaterfallChart,
} from './packProfitBridge';
export { CASH_UNCAPTURED_LABEL, buildCashWaterfallChart } from './packCashBridge';
export type { PackCashBridge } from './packCashBridge';
export {
  buildPositionCompositionChart,
  POSITION_CHART_FLOOR_MM,
  positionCompositionChartAtHeight,
} from './packPositionChart';
