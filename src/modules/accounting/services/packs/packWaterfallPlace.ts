/**
 * WHERE EVERY FIGURE ON A BRIDGE GOES — ONE FUNCTION, ASKED TWICE.
 *
 * `waterfallLayout` calls it on the plot it is about to ask for, to find how
 * far past each bar its figure reaches and extend the axis to hold it; the
 * renderer calls it again on the plot ECharts drew. Given the same geometry
 * they get the same answer, so the room one reserved is the room the other
 * uses.
 *
 * The rule, in order:
 *   1. A figure its bar holds (`figureFitsInside`) goes inside where its own
 *      side has no room or the bar is a subtotal; every other figure goes
 *      wholly outside on its own side — above a rising bar, below a falling
 *      one — and is moved sideways only as far as keeps it on the plot.
 *   2. NO FIGURE MEETS ANOTHER. Outside figures are walked left to right, and
 *      one whose box would come within a halo of a figure already placed is
 *      set a line further out on its own side, and again, until it is clear.
 *      A bridge ending on a falling movement into a negative closing balance
 *      put its last two figures at one height in adjacent bands, and the
 *      later halo erased the earlier digits: "(54 884 558)" read "(54 884 5".
 */
import { figureFitsInside, figureWidthPx, LABEL_GAP_PX } from './packWaterfallFit';

/** The paper halo round a figure set outside its bar: the text's stroke
 *  width. Half of it reaches beyond the glyphs. */
export const FIGURE_HALO_PX = 4;
/** The closest two figures' boxes may stand: clear of each other's halo. */
const MIN_APART_PX = FIGURE_HALO_PX / 2 + 1;
/** A bound on the stagger, not a design: the layout shrinks the type long
 *  before a figure is this many lines out. */
const MAX_LEVEL = 8;

/** A bar as drawn. `width` is `undefined` where the layout cannot know it. */
export interface BarPx {
  centre: number; top: number; height: number; drawnHeight: number; width: number | undefined;
  rises: boolean; falls: boolean; subtotal: boolean; text: string;
}
export interface PlotPx { left: number; right: number; top: number; bottom: number }
export interface Placement {
  inside: boolean; below: boolean; level: number;
  /** The figure's box: `halfWidth` either side of `centre`, `fontPx` down from `top`. */
  centre: number; top: number; halfWidth: number;
}

const apart = (a: Placement, b: Placement, fontPx: number): number => Math.max(
  Math.abs(a.centre - b.centre) - a.halfWidth - b.halfWidth,
  Math.max(a.top, b.top) - Math.min(a.top, b.top) - fontPx,
);

/**
 * @param hold Keep every figure inside the plot's height, whatever it takes.
 *   The renderer's safety net: with a box the layout has reserved the room
 *   and it does not fire. The layout itself passes `false`, because how far a
 *   figure runs past the plot is what it is asking.
 */
export function placeFigures(bars: readonly BarPx[], plot: PlotPx, fontPx: number, hold: boolean): Placement[] {
  const step = fontPx + LABEL_GAP_PX;
  const placed: Array<Placement | undefined> = bars.map((bar) => {
    const roomAbove = bar.top - step >= plot.top;
    const roomBelow = bar.top + bar.drawnHeight + step <= plot.bottom;
    // A NIL step has no side and takes whichever has room.
    const noRoomOnItsSide = bar.falls ? !roomBelow : !roomAbove;
    const inside = figureFitsInside(bar.text, bar.height, bar.width, fontPx) && (noRoomOnItsSide || bar.subtotal);
    if (!inside) return undefined;
    return { inside, below: false, level: 0, centre: bar.centre, top: bar.top + LABEL_GAP_PX, halfWidth: figureWidthPx(bar.text, fontPx) / 2 };
  });
  bars.forEach((bar, i) => {
    if (placed[i] !== undefined) return;
    const halfWidth = figureWidthPx(bar.text, fontPx) / 2;
    const below = bar.falls || (!bar.rises && bar.top - step < plot.top);
    // SIDEWAYS IT STAYS ON THE PLOT. A figure wider than its bar, on the first
    // or last bar, ran past the plot's edge and the clip took its bracket —
    // a negative read as a positive. One wider than the plot is centred on it.
    const centre = plot.right - plot.left < halfWidth * 2 ? (plot.left + plot.right) / 2
      : Math.min(Math.max(bar.centre, plot.left + halfWidth), plot.right - halfWidth);
    const at = (level: number): Placement => ({
      inside: false, below, level, centre, halfWidth,
      top: below ? bar.top + bar.drawnHeight + LABEL_GAP_PX + level * step : bar.top - step - level * step,
    });
    const others = placed.filter((p, j): p is Placement => p !== undefined && (p.inside || j < i));
    let spot = at(0);
    while (spot.level < MAX_LEVEL && others.some((o) => apart(spot, o, fontPx) < MIN_APART_PX)) spot = at(spot.level + 1);
    // THE CLAMP IS A SAFETY NET — never moved to the other side, never
    // clipped out: held at the plot's edge on its own side.
    placed[i] = hold ? { ...spot, top: Math.min(Math.max(spot.top, plot.top), plot.bottom - fontPx) } : spot;
  });
  return placed as Placement[];
}
