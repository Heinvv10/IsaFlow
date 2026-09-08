/**
 * THE BOX THE SVG IS ACTUALLY GIVEN, WHICH IS NOT THE BOX IT WAS RENDERED AT.
 *
 * `PackChartBlock` sets the figure's height to `chart.heightMm` and stacks a
 * `<figcaption>` above the SVG, so `.pack-chart-svg` — `flex: 1` — receives
 * the height LESS the title. The SVG was rendered at the full height, and an
 * SVG whose viewBox does not match its box is letterboxed: `preserveAspect
 * Ratio` defaults to `xMidYMid meet`, which scales it down uniformly and
 * CENTRES it. So the chart lost width in proportion to how tall its title
 * was, and gained equal blank margins either side.
 *
 * That is the whole of the "three chart measures" finding, and it is why the
 * same bridge measured 722px on the demo and 714 on Brightsphere: the titles
 * are different lengths. It is also why the round before this one did not fix
 * it — the grid insets were right and the box they were drawn into was not.
 *
 * The fix is NOT to predict that box better. `svgBoxFor` returns the plot
 * measure, the SVG is rendered at it, AND the same number is handed to the
 * stylesheet as `--pack-chart-plot-mm`, which sizes `.pack-chart-svg`
 * outright instead of leaving it `flex: 1` of whatever the caption spared.
 * The rendered box and the drawn box are then the same number by
 * construction, so nothing is scaled and nothing is centred: the chart spans
 * its container, whose width is the page's text measure, and its right edge
 * is the table rule above it. This is the rule the small multiples have
 * followed since the shared-y-domain finding; it is now the rule for every
 * chart.
 *
 * A wrong title prediction now costs a millimetre of PAGE BUDGET — the
 * figure is its caption plus a fixed plot, so it may stand a millimetre off
 * `heightMm` — rather than a scaled-down chart. That is the cheap failure.
 */
import { lines, wrappedLines } from './packTextMetrics';

/** `.pack-chart-title` — 10pt over 14pt, with 1.5mm under it. */
const TITLE_PT = 10;
const TITLE_LEADING_PT = 14;
const TITLE_GAP_MM = 1.5;

/** The millimetres a chart's own title takes above its plot. */
export function chartTitleMm(title: string, widthMm: number): number {
  return lines(wrappedLines(title, TITLE_PT, widthMm), TITLE_LEADING_PT) + TITLE_GAP_MM;
}

/**
 * The box to RENDER an SVG at, for a figure of `box.heightMm` carrying
 * `title`.
 *
 * Never smaller than a third of the figure: a title long enough to eat its
 * own chart is a different defect, and one this should not answer by
 * rendering a two-millimetre plot.
 */
export function svgBoxFor(
  box: { widthMm: number; heightMm: number },
  title: string,
): { widthMm: number; heightMm: number } {
  const plot = box.heightMm - chartTitleMm(title, box.widthMm);
  return { widthMm: box.widthMm, heightMm: Math.max(box.heightMm / 3, plot) };
}
