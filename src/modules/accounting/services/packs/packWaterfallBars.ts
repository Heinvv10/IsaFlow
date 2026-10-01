/**
 * The waterfall's `custom`-series `renderItem` — one bar, its value label and
 * the label's ground — with the pixel constants that place them. Moved out of
 * `packChartOptions.ts` unchanged to keep that file under the 300-line cap;
 * the geometry, figure and scale notes at the head of that file govern this
 * one.
 */
import type {
  CustomSeriesRenderItem,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
} from 'echarts';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';
import { textWidthEms, WIDTH_SAFETY } from './pages/packTextMetrics';
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import type { ChartPalette } from './packChartAxes';
import { labelInkOn, stepColour } from './packWaterfallPaint';

/**
 * EVERY BAR CARRIES ITS OWN VALUE, AND THE LABEL GOES WHEREVER IT CAN BE READ.
 *
 * The label is drawn four pixels ABOVE the bar. A bar with no room there —
 * one whose top is within a line of the top of the plot, which is every
 * total drawn from the axis — takes one of two fallbacks: INSIDE the bar in
 * paper where the bar is tall enough to hold a line of type, and immediately
 * BELOW it in ink where it is not. Neither is cosmetic:
 *
 *   - Off the top, `clip: true` cuts the label in half. Brightsphere's cash
 *     bridge printed `(3 186)` with its lower half missing on a pack that
 *     called itself final.
 *   - Inside the bar in INK is worse, because it fails silently: the bar is
 *     ink-filled, so the label is drawn and invisible. Sheets 6 and 8 printed
 *     Gross Profit, Net Profit, Opening cash and Closing cash — the four
 *     largest marks in the pack — with no value on them at all, leaving hue
 *     as the only cue for an increase against a decrease.
 *   - Inside a SHORT bar in paper fails the same silent way, on white.
 *
 * A directly labelled bar is also the greyscale cue the rubric asks for:
 * `(1 431)` reads under a photocopier and `red` does not.
 */

const LABEL_GAP_PX = 4;
const LABEL_LINE_PX = 12;

/** What a label set outside its bar needs from the plot: its line and its gap. */
export const LABEL_CLEARANCE_PX = LABEL_GAP_PX + LABEL_LINE_PX;
/** The shortest bar that holds its own label inside — see `fitsInside`. */
export const LABEL_INSIDE_PX = LABEL_LINE_PX + LABEL_GAP_PX * 2;

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
const NIL_STEP_RULE_PX = 1;

/**
 * A GRIDLINE MAY NOT RUN THROUGH A FIGURE.
 *
 * Brightsphere's sheet 6 drew the `(1 000)` gridline (y 397.1pt, the full
 * width of the plot) straight through the `(411)` label sitting outside its
 * bar — at 500dpi the rule cuts the bottom of both parentheses. It was the
 * only visible strike in twenty-four sheets, and the demo's near-miss shows
 * why: `1 431` sits across the zero line at 391.1pt and is invisible only
 * because the red bar is painted over the gridline and the label sits on the
 * bar. Paint order saves the one and not the other, so the picture is one
 * condition — a shorter bar, a different domain — away from the same strike
 * on either company.
 *
 * A label INSIDE its bar already has a knockout: the bar. A label above or
 * below one has nothing behind it but the plot, so it gets a paper rect of
 * its own. Not a paint-order fix, because there is nothing wrong with the
 * paint order — the label is already drawn after the gridlines; what shows
 * through is the gap between the glyphs' strokes, and only an opaque ground
 * closes that.
 */
const LABEL_KNOCKOUT_PAD_PX = 2;

/**
 * How wide a chart label is drawn, in pixels.
 *
 * The pack's own ruler — the same em table and the same `WIDTH_SAFETY` the
 * page composer measures prose with, so the knockout is at least as wide as
 * the glyphs whatever the renderer does with them. Generous is the safe
 * direction here: a knockout wider than its text hides a millimetre more
 * gridline; a knockout narrower than its text leaves a rule running out of
 * the side of a figure, which is the defect.
 */
function labelWidthPx(text: string, fontPx: number): number {
  return textWidthEms(text) * fontPx * WIDTH_SAFETY;
}

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
    const width = band * 0.6;
    const x = x1 - width / 2;
    const y = Math.min(y1, y2);
    const height = Math.abs(y1 - y2);
    // See `NIL_STEP_RULE_PX`: a zero-height step paints a rule on its running
    // total rather than nothing at all.
    const drawnHeight = Math.max(height, NIL_STEP_RULE_PX);
    // AND THE SHEET IS TOLD WHICH BAR THAT WAS. A bar drawn taller than its
    // own figure is the one mark on a bridge a reader cannot check against
    // the axis, so the rule has to be declared where it fired — and the only
    // place the firing is known is here, where the pixels are. Reported
    // rather than re-derived: the height that trips the floor is pixels of a
    // plot box no caller computes.
    if (height < NIL_STEP_RULE_PX) onFloored?.(step.label);

    // The top of the plot, asked of the coordinate system rather than assumed
    // from `grid.top`: `containLabel` and the axis name both move it, and the
    // domain's own maximum is where the plot ends.
    const [, plotTop = 0] = api.coord([params.dataIndex, domain.max]);
    const above = y - LABEL_GAP_PX;
    const noRoomAbove = above - LABEL_LINE_PX < plotTop;
    // Inside the bar only if the bar is tall enough to hold a line of type.
    const fitsInside = height >= LABEL_INSIDE_PX;
    // A LABEL SET IN THE BAR'S OWN INK NEVER SITS ABOVE IT.
    //
    // A subtotal is filled with `palette.ink` and its label above it was set
    // in `palette.ink` too, four pixels clear of a twelve-pixel line — so the
    // type and the fill are one mark. A blind gate measured the demo pack's
    // Gross Profit bar as running from +96 to (1 325) against a table reading
    // (1 329) and called the bar 7.6% overstated; +96 is 16 page pixels of
    // dark, which is exactly the label's line plus its gap. The bar is based
    // at zero — measured off the composed SVG, rect top 61.0 with zero at
    // 61.0 — and no arithmetic was wrong. What was wrong is that a reader
    // could not see where the bar ended.
    //
    // IT HID ON THE OTHER COMPANY for the reason this branch keeps finding.
    // Brightsphere's totals reach the top of the plot, so `noRoomAbove` put
    // their labels INSIDE in paper, and there was no dark type above a dark
    // bar to merge with. Right on one sheet, ambiguous on the other, off one
    // rule that never asked what the bar was filled with.
    //
    // So a bar whose fill IS the label's ink carries its label inside, in
    // paper — the placement half of what `labelInkOn` already does for
    // contrast — and the two companies draw the same picture. A total too
    // short to hold a line of type keeps the old fallbacks.
    const sameInkAsFill = stepColour(step, palette) === palette.ink;
    // AND A SAME-INK BAR TOO SHORT TO HOLD ITS LABEL keeps it on its own
    // side like any other bar, set in the axis ink where that side is above
    // it, so the type and the fill do not merge into one mark.
    const [, plotBottom = Infinity] = api.coord([params.dataIndex, domain.min]);
    const roomBelow = y + drawnHeight + LABEL_GAP_PX + LABEL_LINE_PX <= plotBottom;
    // AND NEVER ON THE WRONG SIDE OF ITS BASE. A rising bar's figure is set
    // above it and a falling bar's below it: the side reads as the sign. The
    // demo's Revenue of 101, a short bar with the domain ending a few pixels
    // over it, hung its figure under the zero line. Where the correct side has
    // no room the plot is given room (`labelledDomain`) and the label keeps its
    // side; a bar tall enough takes it inside instead. A NIL step has no side
    // and takes whichever has room.
    const falls = step.end < step.start;
    const rises = step.end > step.start;
    const noRoomOnItsSide = falls ? !roomBelow : noRoomAbove;
    const inside = fitsInside && (noRoomOnItsSide || sameInkAsFill);
    const below = !inside && (falls || (!rises && noRoomAbove));
    const aboveInOwnInk = !inside && !below && sameInkAsFill;

    const text = formatMoney(step.labelValue ?? step.value, { scale });
    // `drawnHeight`, not `height`: a floored bar is drawn a rule's width
    // taller than its figure, and the gap is kept from what is drawn.
    const textY = inside ? y + LABEL_GAP_PX : below ? y + drawnHeight + LABEL_GAP_PX : above;
    // THE GROUND UNDER A LABEL THAT IS NOT ON ITS BAR — see
    // `LABEL_KNOCKOUT_PAD_PX`. Inside the bar the fill is the ground already,
    // and a paper rect there would punch a hole in the bar.
    const knockoutW = labelWidthPx(text, LABEL_LINE_PX) + LABEL_KNOCKOUT_PAD_PX * 2;
    const knockout = inside ? [] : [{
      type: 'rect' as const,
      // NAMED, because the bar is a rect too and a reader of this group —
      // `packChartOptions.test.ts` reads it by name — must not take the
      // ground for the bar.
      name: 'labelGround',
      // `above` anchors the text's BOTTOM and `below` its top — see
      // `verticalAlign` on the label. The ground follows the same anchor, or
      // it covers the wrong line of the plot.
      shape: {
        x: x + width / 2 - knockoutW / 2,
        y: (below ? textY : textY - LABEL_LINE_PX) - LABEL_KNOCKOUT_PAD_PX,
        width: knockoutW,
        height: LABEL_LINE_PX + LABEL_KNOCKOUT_PAD_PX * 2,
      },
      style: { fill: palette.paper },
    }];

    return {
      type: 'group',
      children: [
        // THE KNOCKOUT FIRST, AND THE BAR AFTER IT. It never overlaps the bar
        // — it exists only where the label sits clear of one — so the order
        // between those two is free, and drawing it first keeps every bar's
        // `<path>` immediately followed by its own `<text>` in the emitted
        // SVG. `packWaterfallLegibility.test.ts` pairs a bar with its label by
        // that adjacency, which is the renderer's own pairing rather than a
        // guessed coordinate match, and an element between them breaks it.
        ...knockout,
        {
          type: 'rect',
          name: 'bar',
          shape: { x, y, width, height: drawnHeight },
          style: { fill: stepColour(step, palette) },
        },
        {
          type: 'text',
          style: {
            // THE TABLE'S SIGN, NOT THE STEP'S EFFECT ON PROFIT — see
            // `WaterfallStep.labelValue`. The bar's direction already carries
            // the effect; printing the negation of the figure in the table on
            // the same sheet made the chart look like it disagreed with it.
            text,
            x: x + width / 2,
            // A bar that reaches the top of the domain has no room above it,
            // so its label sits just inside the bar instead of half off the
            // paper. See `LABEL_GAP_PX`.
            y: textY,
            // INSIDE THE BAR IT IS SET IN PAPER, NOT INK. Every bar drawn
            // from the axis reaches the top of its own plot, so `clipped` is
            // true of every TOTAL — and ink on an ink-filled total bar is an
            // invisible label. Sheets 6 and 8 printed Gross Profit, Net
            // Profit, Opening cash and Closing cash — the largest marks in
            // the pack — carrying no value at all, which left red/green hue
            // as the only thing separating an increase from a decrease on
            // them. The label was being drawn the whole time.
            fill: inside ? labelInkOn(stepColour(step, palette), palette) : aboveInOwnInk ? palette.axis : palette.ink,
            // AND THE PACK'S FACE, NAMED HERE BECAUSE THIS IS A RAW ZRENDER
            // TEXT AND NOT AN ECHARTS LABEL.
            //
            // A `custom` series draws its own elements, and a zrender text
            // takes its font from `style.font`, whose default is the literal
            // `12px sans-serif` — it does not read `option.textStyle` the way
            // an axis label does. So `renderChartSvg` stamping the family on
            // the option reached every label on the sheet EXCEPT these, and
            // the bridge's bar values kept printing in whatever Chromium
            // resolves `sans-serif` to. On the demo income statement that put
            // `1 431` on the sheet twice in two typefaces — once in the Cost
            // of sales row, once on its own bar a centimetre below.
            fontFamily: PACK_FONT_STACK,
            align: 'center',
            verticalAlign: inside || below ? 'top' : 'bottom',
          },
        },
      ],
    };
  };
}
