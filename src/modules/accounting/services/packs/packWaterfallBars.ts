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
import {
  BAR_SHARE_OF_BAND, figureFitsInside, figureText, figureWidthPx, LABEL_GAP_PX, LABEL_LINE_PX,
} from './packWaterfallFit';

export { LABEL_CLEARANCE_PX, LABEL_INSIDE_PX } from './packWaterfallFit';

/**
 * EVERY BAR CARRIES ITS OWN VALUE, IN ONE OF TWO STATES.
 *
 * INSIDE the bar, in the ink that reads on the fill, where the bar holds the
 * figure (`figureFitsInside` — tall enough AND wide enough). Otherwise wholly
 * OUTSIDE it on its own side — above a rising bar, below a falling one, the
 * side reads as the sign — in ordinary ink, in room `waterfallLayout` reserved
 * by asking the same question. Never part on and part off:
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
 * outside has only the plot, so its glyphs carry a paper HALO: the text's own
 * stroke in the paper colour, painted under its fill (`paint-order: stroke`).
 *
 * A halo and not a paper rectangle, because a rectangle as wide as a long
 * figure reached over the neighbouring bars and their figures and painted
 * them out. The halo follows the glyphs and covers nothing else.
 */
const LABEL_HALO_PX = 4;
/** The paper kept round a figure that has to sit on a bar. */
const GROUND_PAD_PX = 2;
/** Figures over grounds over bars, whichever bar they belong to. */
const FIGURE_Z2 = 2;

export function makeWaterfallRenderItem(
  steps: WaterfallStep[],
  palette: ChartPalette,
  scale: MoneyScale,
  domain: { min: number; max: number },
  onFloored: ((label: string) => void) | undefined,
): CustomSeriesRenderItem {
  return function renderItem(params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) {
    const step = steps[params.dataIndex];
    if (!step) return undefined;

    const [x1 = 0, y1 = 0] = api.coord([params.dataIndex, step.start]);
    const [, y2 = 0] = api.coord([params.dataIndex, step.end]);
    const bandRaw = api.size ? api.size([1, 0]) : undefined;
    const band = (Array.isArray(bandRaw) ? bandRaw[0] : typeof bandRaw === 'number' ? bandRaw : 20) ?? 20;
    const width = band * BAR_SHARE_OF_BAND;
    const x = x1 - width / 2;
    const y = Math.min(y1, y2);
    const height = Math.abs(y1 - y2);
    // See `NIL_STEP_RULE_PX`: a zero-height step paints a rule on its running
    // total rather than nothing at all.
    const drawnHeight = Math.max(height, NIL_STEP_RULE_PX);
    // AND THE SHEET IS TOLD WHICH BAR THAT WAS. A bar drawn taller than its
    // own figure is the one mark on a bridge a reader cannot check against
    // the axis, so the rule has to be declared where it fired — and the only
    // place the firing is known is here, where the pixels are.
    if (height < NIL_STEP_RULE_PX) onFloored?.(step.label);

    // THE RECTANGLE ECHARTS ACTUALLY DREW, from the coordinate system it
    // hands this function — not the domain's ends mapped through `coord`,
    // which is the same thing only when nothing shrank the grid. Where it is
    // absent, the domain's ends.
    const rect = (params as { coordSys?: { x?: number; y?: number; width?: number; height?: number } }).coordSys;
    const [, domainTop = 0] = api.coord([params.dataIndex, domain.max]);
    const [, domainBottom = Infinity] = api.coord([params.dataIndex, domain.min]);
    const plotTop = rect?.y ?? domainTop;
    const plotBottom = rect?.y !== undefined && rect.height !== undefined ? rect.y + rect.height : domainBottom;

    const text = figureText(step, scale);
    const fill = stepColour(step, palette);
    const falls = step.end < step.start;
    const rises = step.end > step.start;
    const roomAbove = y - LABEL_GAP_PX - LABEL_LINE_PX >= plotTop;
    const roomBelow = y + drawnHeight + LABEL_GAP_PX + LABEL_LINE_PX <= plotBottom;
    // A NIL step has no side and takes whichever has room.
    const noRoomOnItsSide = falls ? !roomBelow : !roomAbove;
    // A LABEL SET IN THE BAR'S OWN INK NEVER SITS ABOVE IT. A subtotal is
    // filled with `palette.ink`, and its figure four pixels above it in the
    // same ink made the type and the fill one mark — a blind gate measured
    // the demo's Gross Profit bar as 7.6% overstated, which was exactly the
    // label's line plus its gap. So a bar whose fill IS the figure's ink
    // carries it inside wherever it fits, and where it does not the figure
    // above is set in the axis ink.
    const sameInkAsFill = fill === palette.ink;
    // THE TWO STATES. Inside only where the bar holds the whole figure, and
    // then only where it has to be (no room on its side) or reads better
    // (the same-ink bar). Everything else is outside, on its own side.
    const inside = figureFitsInside(text, height, width) && (noRoomOnItsSide || sameInkAsFill);
    const below = !inside && (falls || (!rises && !roomAbove));
    // `drawnHeight`, not `height`: a floored bar is drawn a rule's width
    // taller than its figure, and the gap is kept from what is drawn.
    //
    // THE CLAMPS ARE A SAFETY NET. With a box the layout has reserved the
    // room and neither fires. Without one — or if the layout could not
    // settle — the figure is still never moved to the other side and never
    // clipped out: it is held at the plot's edge on its own side.
    const textTop = inside ? y + LABEL_GAP_PX
      : below ? Math.min(y + drawnHeight + LABEL_GAP_PX, plotBottom - LABEL_LINE_PX)
      : Math.max(y - LABEL_GAP_PX, plotTop + LABEL_LINE_PX) - LABEL_LINE_PX;
    // AND SIDEWAYS IT STAYS ON THE PLOT TOO. A figure wider than its bar, on
    // the first or last bar, ran past the plot's edge and the clip took its
    // bracket — a negative read as a positive. It is moved along until it is
    // whole; one wider than the whole plot is centred on it.
    const half = figureWidthPx(text) / 2;
    const centre = inside || rect?.x === undefined || rect.width === undefined ? x + width / 2
      : rect.width < half * 2 ? rect.x + rect.width / 2
      : Math.min(Math.max(x + width / 2, rect.x + half), rect.x + rect.width - half);
    // AND WHERE IT STILL LANDS ON A BAR — a neighbour's, under a figure wider
    // than its own band, or its own where the clamps above fired — it keeps
    // its ordinary ink on a paper ground cut to the figure. Never the bar's
    // contrasting ink with part of the figure off the bar. Figures and
    // grounds are painted over every bar (`z2`), so no later bar hides one.
    const onABar = !inside && steps.some((other, j) => {
      const [ox = 0, oy1 = 0] = api.coord([j, other.start]);
      const [, oy2 = 0] = api.coord([j, other.end]);
      const top = Math.min(oy1, oy2);
      return ox - width / 2 < centre + half && ox + width / 2 > centre - half
        && top < textTop + LABEL_LINE_PX && top + Math.max(Math.abs(oy1 - oy2), NIL_STEP_RULE_PX) > textTop;
    });

    return {
      type: 'group',
      children: [
        {
          type: 'rect',
          name: 'bar',
          shape: { x, y, width, height: drawnHeight },
          style: { fill },
        },
        ...(onABar ? [{
          type: 'rect' as const,
          name: 'labelGround',
          z2: FIGURE_Z2 - 1,
          shape: { x: centre - half - GROUND_PAD_PX, y: textTop - GROUND_PAD_PX, width: (half + GROUND_PAD_PX) * 2, height: LABEL_LINE_PX + GROUND_PAD_PX * 2 },
          style: { fill: palette.paper },
        }] : []),
        {
          type: 'text',
          z2: FIGURE_Z2,
          style: {
            text,
            x: centre,
            y: textTop,
            fill: inside ? labelInkOn(fill, palette) : !below && sameInkAsFill ? palette.axis : palette.ink,
            ...(inside ? {} : { stroke: palette.paper, lineWidth: LABEL_HALO_PX }),
            // THE PACK'S FACE, NAMED HERE BECAUSE THIS IS A RAW ZRENDER TEXT
            // AND NOT AN ECHARTS LABEL. A zrender text takes its font from
            // `style.font`, whose default is the literal `12px sans-serif` —
            // it does not read `option.textStyle` — so the family stamped on
            // the option reached every label on the sheet EXCEPT these, and
            // the demo printed `1 431` twice in two typefaces.
            fontFamily: PACK_FONT_STACK,
            align: 'center',
            verticalAlign: 'top',
          },
        },
      ],
    };
  };
}
