/**
 * The waterfall's `custom`-series `renderItem` — one bar and its figure —
 * with the pixel constants that place them. Moved out of
 * `packChartOptions.ts` to keep that file under the 300-line cap; the
 * geometry, figure and scale notes at the head of that file govern this one.
 */
import type { CustomSeriesRenderItem, CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';
import type { MoneyScale } from '@/lib/format/money';
import type { ChartPalette } from './packChartAxes';
import { labelInkOn, stepColour } from './packWaterfallPaint';
import { BAR_SHARE_OF_BAND, figureText, LABEL_LINE_PX } from './packWaterfallFit';
import { FIGURE_HALO_PX, placeFigures, type BarPx } from './packWaterfallPlace';

export { LABEL_CLEARANCE_PX, LABEL_INSIDE_PX } from './packWaterfallFit';

/**
 * EVERY BAR CARRIES ITS OWN VALUE, IN ONE OF TWO STATES.
 *
 * INSIDE the bar, in the ink that reads on the fill, where the bar holds the
 * figure (`figureFitsInside` — tall enough AND wide enough). Otherwise wholly
 * OUTSIDE it on its own side — above a rising bar, below a falling one, the
 * side reads as the sign — in ordinary ink, in room `waterfallLayout` reserved
 * by asking the same function this renderer asks (`placeFigures`), which also
 * keeps every figure clear of every other. Never part on and part off:
 *
 *   - Off the top, `clip: true` cuts the figure in half. Brightsphere's cash
 *     bridge printed `(3 186)` with its lower half missing.
 *   - On an ink-filled bar in INK it is drawn and invisible. Sheets 6 and 8
 *     printed their four largest marks with no value on them at all.
 *   - In PAPER ink across a bar's edge, the half off the bar is white on
 *     white: the management pack printed `226 871` with the bottom of every
 *     digit gone, and a bracket lost that way turns a negative positive.
 *
 * A directly labelled bar is also the greyscale cue the rubric asks for:
 * `(1 431)` reads under a photocopier and `red` does not.
 */

/**
 * A NIL STEP IS STILL A STEP, AND IT HAS TO BE DRAWN WHERE IT HAPPENS.
 *
 * A step whose value is nil spans zero user units, so its rect is zero pixels
 * tall and paints nothing. The label is still drawn, four pixels ABOVE that
 * empty position and set from the baseline up, which puts the glyphs about a
 * line of type clear of the running total they belong to. On Brightsphere's
 * page 6 bridge — 21.25px per R1m, zero at y=818 — the nil cost-of-sales step
 * belongs at y=935.6 and its `–` landed at y=923.5, ON THE (5 000) GRIDLINE.
 * The table two inches above the chart says nil. Any director who reads a
 * bridge against its axis took cost of sales as about five million.
 *
 * So a step that would paint nothing paints a rule instead, one pixel on the
 * running total. That is the reading a nil step should get — the line did not
 * move — and it re-anchors the label, which now sits four pixels above a mark
 * that is actually there rather than above nothing.
 *
 * The floor is on the DRAWN height only. `y` is still the true position, so
 * the label placement and the plot-top test are unchanged, and a rule cannot
 * shift a step that has real height: `Math.max` is a no-op above one pixel.
 */
export const NIL_STEP_RULE_PX = 1;

/**
 * A GRIDLINE MAY NOT RUN THROUGH A FIGURE.
 *
 * Brightsphere's sheet 6 drew the `(1 000)` gridline straight through the
 * `(411)` figure sitting outside its bar — at 500dpi the rule cuts the bottom
 * of both parentheses. A figure inside its bar has the bar behind it; one
 * outside has only the plot, so it gets a paper GROUND: a rectangle cut to
 * the figure's own box, painted over the bars and under every figure.
 *
 * CUT TO THE FIGURE, which is what makes a rectangle safe. The first one was
 * as wide as a generous prose ruler made it and reached over the neighbours'
 * bars and digits. This one is the glyphs' real width and two pixels; no two
 * figures stand that close (`placeFigures`), and it lies under all of them,
 * so the only thing it can cover is a bar the figure is already standing on
 * — where the figure needs it.
 *
 * AND A HALO IS NOT ENOUGH ON ITS OWN. For two rounds the ground was dropped
 * for a paper stroke on the glyphs. It reaches two pixels from each glyph and
 * the gap at a thousands separator is nearer five: the management pack
 * printed the (1 500 000) gridline through "1 430 581" and "(1 329 181)"
 * between every group of digits. The halo stays — a pass of its own, under
 * every figure's fill (`z2`), softening the ground's edge where a bar passes
 * behind — but the ground is what covers the rule.
 */
/** The paper kept round a figure outside its bar. */
const GROUND_PAD_PX = 2;
/** Fills over halos over grounds over bars, whichever bar they belong to. */
const GROUND_Z2 = 1;
const HALO_Z2 = 2;
const FIGURE_Z2 = 3;

export function makeWaterfallRenderItem(
  steps: WaterfallStep[],
  palette: ChartPalette,
  scale: MoneyScale,
  domain: { min: number; max: number },
  onFloored: ((label: string) => void) | undefined,
  /** The size the layout chose for this chart's figures. */
  fontPx: number = LABEL_LINE_PX,
): CustomSeriesRenderItem {
  return function renderItem(params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) {
    const step = steps[params.dataIndex];
    if (!step) return undefined;

    const bandRaw = api.size ? api.size([1, 0]) : undefined;
    const band = (Array.isArray(bandRaw) ? bandRaw[0] : typeof bandRaw === 'number' ? bandRaw : 20) ?? 20;
    const width = band * BAR_SHARE_OF_BAND;
    // EVERY BAR, because where a figure goes depends on its neighbours'.
    const bars: BarPx[] = steps.map((other, j) => {
      const [centre = 0, y1 = 0] = api.coord([j, other.start]);
      const [, y2 = 0] = api.coord([j, other.end]);
      const height = Math.abs(y1 - y2);
      return {
        centre, top: Math.min(y1, y2), height, width,
        // See `NIL_STEP_RULE_PX`: a zero-height step paints a rule on its
        // running total rather than nothing at all.
        drawnHeight: Math.max(height, NIL_STEP_RULE_PX),
        rises: other.end > other.start, falls: other.end < other.start, subtotal: other.isSubtotal,
        text: figureText(other, scale),
      };
    });
    const bar = bars[params.dataIndex]!;
    const x = bar.centre - width / 2;
    // AND THE SHEET IS TOLD WHICH BAR THAT WAS. A bar drawn taller than its
    // own figure is the one mark on a bridge a reader cannot check against
    // the axis, so the rule has to be declared where it fired — and the only
    // place the firing is known is here, where the pixels are.
    if (bar.height < NIL_STEP_RULE_PX) onFloored?.(step.label);

    // THE RECTANGLE ECHARTS ACTUALLY DREW, from the coordinate system it
    // hands this function — not the domain's ends mapped through `coord`,
    // which is the same thing only when nothing shrank the grid. Where it is
    // absent, the domain's ends.
    const rect = (params as { coordSys?: { x?: number; y?: number; width?: number; height?: number } }).coordSys;
    const [, domainTop = 0] = api.coord([params.dataIndex, domain.max]);
    const [, domainBottom = Infinity] = api.coord([params.dataIndex, domain.min]);
    const plot = {
      left: rect?.x ?? -Infinity,
      right: rect?.x !== undefined && rect.width !== undefined ? rect.x + rect.width : Infinity,
      top: rect?.y ?? domainTop,
      bottom: rect?.y !== undefined && rect.height !== undefined ? rect.y + rect.height : domainBottom,
    };
    // WHERE IT GOES — see `placeFigures`. `hold`: with no box the layout
    // reserved nothing, and the figure is still never clipped out.
    const spot = placeFigures(bars, plot, fontPx, true)[params.dataIndex]!;
    const fill = stepColour(step, palette);
    // A LABEL SET IN THE BAR'S OWN INK NEVER SITS ABOVE IT. A subtotal is
    // filled with `palette.ink`, and its figure four pixels above it in the
    // same ink made the type and the fill one mark — a blind gate measured
    // the demo's Gross Profit bar as 7.6% overstated, which was exactly the
    // label's line plus its gap. So a subtotal carries its figure inside
    // wherever it fits, and where it does not the figure above is set in the
    // axis ink.
    const ink = spot.inside ? labelInkOn(fill, palette) : !spot.below && fill === palette.ink ? palette.axis : palette.ink;
    // The ground: the figure's box and its padding, kept on the plot.
    const groundLeft = Math.max(spot.centre - spot.halfWidth - GROUND_PAD_PX, plot.left);
    const groundRight = Math.min(spot.centre + spot.halfWidth + GROUND_PAD_PX, plot.right);
    const type = {
      text: bar.text,
      x: spot.centre,
      y: spot.top,
      fontSize: fontPx,
      // THE PACK'S FACE, NAMED HERE BECAUSE THIS IS A RAW ZRENDER TEXT AND NOT
      // AN ECHARTS LABEL. A zrender text takes its font from `style.font`,
      // whose default is the literal `12px sans-serif` — it does not read
      // `option.textStyle` — so the family stamped on the option reached
      // every label on the sheet EXCEPT these, and the demo printed `1 431`
      // twice in two typefaces.
      fontFamily: PACK_FONT_STACK,
      align: 'center' as const,
      verticalAlign: 'top' as const,
    };

    return {
      type: 'group',
      children: [
        {
          type: 'rect',
          name: 'bar',
          shape: { x, y: bar.top, width, height: bar.drawnHeight },
          style: { fill },
        },
        ...(spot.inside ? [] : [{
          type: 'rect' as const,
          name: 'labelGround',
          z2: GROUND_Z2,
          shape: { x: groundLeft, y: spot.top - GROUND_PAD_PX, width: groundRight - groundLeft, height: fontPx + GROUND_PAD_PX * 2 },
          style: { fill: palette.paper },
        }, {
          type: 'text' as const,
          name: 'labelHalo',
          z2: HALO_Z2,
          style: { ...type, fill: 'none', stroke: palette.paper, lineWidth: FIGURE_HALO_PX },
        }]),
        { type: 'text', z2: FIGURE_Z2, style: { ...type, fill: ink } },
      ],
    };
  };
}
