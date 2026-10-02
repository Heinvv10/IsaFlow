/**
 * The plot insets every full-width pack chart shares. Moved out of
 * `packChartOptions.ts` unchanged to keep that file under the 300-line cap;
 * `packChartOptions.ts` re-exports all three, so existing import paths still
 * resolve.
 */

/**
 * THE PLOT INSETS EVERY FULL-WIDTH CHART SHARES.
 *
 * The waterfall and the composition bar took `left: 80, right: 24` and the
 * full-width line took `left: 4, right: 64, containLabel: true` — so three
 * chart kinds on one document drew their plots at three different measures
 * and three different left edges, none of them centred on the paper. Measured
 * on the rendered pack: 609, 515 and 581 pixels against a table measure of
 * 753.
 *
 * SYMMETRIC, which is what makes the plot centred on the page rather than
 * merely consistent. The left gutter is the y-axis labels' and cannot go; the
 * right gutter is the line chart's end label, which needs 64. Giving both
 * sides the larger of the two costs the bar charts some plot and buys every
 * chart in the pack one measure and one centre line — the same trade the
 * scorecard's `<colgroup>` makes, and the criterion it is failed on.
 *
 * `containLabel` is deliberately NOT set: it sizes the gutter from whatever
 * the axis happens to print, which is exactly how the small multiples came to
 * have three different left edges in one column.
 */
export const CHART_GUTTER_PX = 80;

/**
 * AND THE RIGHT GUTTER IS NOTHING, BECAUSE A CHART'S RIGHT EDGE IS THE TABLE
 * RULE ABOVE IT OR IT IS NOT ON THE GRID.
 *
 * The round before this one gave every full-width chart the SAME gutter both
 * sides — consistent, centred, and still 109 to 129 pixels short of the
 * table rule on every chart page. Pixel-scanned at 911px: the rules end at
 * 821 and the plots at 704, 699 and lower, so a blank band about 3cm wide at
 * A4 runs down the right of pages 6, 7 and 8 in both packs. Consistency was
 * the wrong target; the measure is.
 *
 * Zero, and the y-axis labels keep the LEFT gutter because they have nowhere
 * else to go. That is the asymmetry the paper actually has: a chart's left
 * edge is where its labels end and its right edge is the page's, which is
 * what every table on every sheet already does.
 *
 * The line chart's end label used to live in this gutter and now sits inside
 * the plot — see `packLineChartOptions`. Nothing else was in it.
 */
export const CHART_GUTTER_RIGHT_PX = 0;

/**
 * What a labelled category axis costs on the right whatever its labels say.
 *
 * ECharts keeps the extreme x label inside the plot by shrinking the plot,
 * so a centred one took half its own width off the chart's measure. The end
 * labels are anchored to the plot's ends now (`alignMaxLabel`), which leaves
 * this fixed reserve — 3px of 658, 0.8mm on the sheet — and no longer varies
 * with the label. A negative `grid.right` does not reclaim it: ECharts
 * clamps, which was measured.
 */
export const AXIS_END_LABEL_RESERVE_PX = 3;
