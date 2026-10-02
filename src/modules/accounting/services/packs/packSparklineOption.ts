/**
 * The page-3 tile sparkline's chart option. Moved out of
 * `packLineChartOptions.ts` unchanged to keep that file under the 300-line
 * cap; `packLineChartOptions.ts` re-exports it, so existing import paths
 * still resolve.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { DEFAULT_CHART_PALETTE, type ChartPalette } from './packChartAxes';
import type { TrendPoint } from './packChartOptions';

/**
 * A tile sparkline: the shape of the series and nothing else. No axes, no
 * grid, no labels — at 60mm × 48mm beside a big number, an axis frame is
 * noise a reader cannot read anyway.
 */
export function sparklineOption(
  points: TrendPoint[],
  palette: ChartPalette = DEFAULT_CHART_PALETTE,
  /**
   * The y-domain to draw on, or omitted to let the line fill its own tile.
   *
   * SAME RULE AS `smallMultipleOption`, AND FOR THE SAME REASON. Page 10
   * shares one domain across its money panels so that "neither of them can
   * look like it moved more than it did" — its own words. Page 3 did not, and
   * a tile-normalised line draws every series to the full height of its box:
   * on the demo pack a revenue swing of 37 and a net-profit swing of 2 692
   * were 313 px and 303 px tall, in the same units, in one row of tiles four
   * centimetres apart; on Brightsphere the SMALLER of the two swings was drawn
   * the DEEPER. The page said nothing about it either — its footnote covers
   * the window and its paragraph headed Scale covers rounding — so the one
   * scale on the sheet that distorted was the one with no domain stated.
   *
   * Omitted for a series in another UNIT (a percentage, a day count): those
   * cannot share a rand domain, so they keep their own and the page says so.
   */
  domain?: { min: number; max: number },
): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 2, right: 2, top: 4, bottom: 4 },
    // THE LINE SPANS THE TILE WHATEVER THE POINT COUNT.
    //
    // A category axis reserves half a band at each end, so a 3-point series
    // was drawn across a third of the width a 12-point series used: page 3's
    // row rendered lines 147px and 106px wide, at 8px and 28px from the tile
    // edge, in one row of tiles the reader compares by shape. The sparklines
    // are already the same BOX; this makes them the same MEASURE.
    xAxis: { type: 'category', data: points.map((p) => p.label), show: false, boundaryGap: false },
    yAxis: domain === undefined
      ? { type: 'value', show: false, scale: true }
      : { type: 'value', show: false, min: domain.min, max: domain.max },
    series: [
      {
        name: 'Actual',
        type: 'line',
        showSymbol: false,
        smooth: false,
        lineStyle: { color: palette.ink, width: 1.5 },
        itemStyle: { color: palette.ink },
        data: points.map((p) => p.value),
      },
    ],
  };
}
