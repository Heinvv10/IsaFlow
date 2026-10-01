/**
 * What the pack's two bridges share: how many gridline steps a box has room
 * for, and the `PackWaterfallBar`s that mirror what is drawn so the integrity
 * gate can walk the bridge. Split out of `packPageCharts.ts` for the 300-line
 * cap.
 */
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { stepPaint, waterfallChromePx } from '@/modules/accounting/services/packs/packChartOptions';
import { TICK_PITCH_PX } from '@/modules/accounting/services/packs/packWaterfallDomain';
import type { PackWaterfallBar, PlugReason } from './packPageModel';

/**
 * HOW MANY GRIDLINE STEPS THIS BOX HAS ROOM FOR.
 *
 * `waterfallOption` defaults to six, which suits the 110mm rung and
 * overprints on the 48mm one: the demo cash bridge drew seven tick labels
 * with 11.8px between their centres at 12px type. The plot is the box less
 * `grid.top` and `grid.bottom`, which `waterfallChromePx` reports because
 * the bottom rung draws them tighter. This is the ASK, at `TICK_PITCH_PX`
 * (26px, comfortable for a 12px label); what is ENFORCED is the 18px
 * legibility floor `waterfallLayout` holds the drawn axis to.
 */
export const PX_PER_MM = 96 / 25.4;

/**
 * EVERY PRINT BRIDGE TAKES THE COMPACT CHROME — the tighter margins and the
 * category names a size smaller; see `WATERFALL_CHROME`.
 *
 * The rule is: at every height, the chrome that leaves the TALLER plot, so a
 * chart that gets taller never gets a smaller plot. The full chrome is 28px
 * more margin and 12px names against 10, which under a long step name is 44:
 * it never leaves the taller plot in the same box, at any height from the
 * bottom rung to the top one (`packGrownBridge.test.ts` holds that premise).
 * It was once the bottom rung alone, and a bridge grown a millimetre past 48
 * had half the plot of the rung it grew from; then every box under the half
 * rung, and a bridge with room for 72mm had a smaller plot than one with room
 * for 71. Stated as a function of the box so a caller still asks, and so a
 * chrome that did win somewhere would be chosen here.
 */
export function isCompact(_box: { heightMm: number }): boolean {
  return true;
}

/**
 * @param plotMm The height the SVG is actually rendered at — the box less its
 *   title (`svgBoxFor`). Defaults to the box, which over-counts by the
 *   title's height: page 8's bridge was asked for four steps in a plot with
 *   room for three.
 */
export function intervalsFor(box: { heightMm: number }, plotMm = box.heightMm): number {
  const plot = plotMm * PX_PER_MM - waterfallChromePx(isCompact(box));
  return Math.max(2, Math.floor(plot / TICK_PITCH_PX));
}

function barKind(step: WaterfallStep, index: number, count: number): PackWaterfallBar['kind'] {
  if (index === 0) return 'open';
  if (index === count - 1) return 'close';
  // A mid-statement rest point, drawn from the axis. Reporting it as an
  // increase or a decrease would tell the gate to walk `start` against the
  // previous bar's `end` — which is 0 against the running chain, i.e. a
  // break in a bridge that is in fact correct.
  if (step.isSubtotal) return 'subtotal';
  return step.end >= step.start ? 'increase' : 'decrease';
}

/**
 * @param uncapturedLabel The step drawn only to make the bridge foot, if any.
 *   Marked on the bar rather than matched by label downstream: the
 *   proportion check must not break when either plug is re-worded.
 */
export function toBars(
  steps: WaterfallStep[],
  uncapturedLabel: string | null,
  /** WHY that step exists, carried onto the bar — the two bridges plug for
   *  different reasons and the sentence that explains one is false of the
   *  other. Required alongside the label, so a plug cannot be marked without
   *  one. See `PlugReason`. */
  uncapturedReason: PlugReason,
): PackWaterfallBar[] {
  return steps.map((step, index) => {
    const paint = stepPaint(step);
    return {
      label: step.label,
      start: step.start,
      end: step.end,
      kind: barKind(step, index, steps.length),
      ...(step.label === uncapturedLabel ? { uncaptured: uncapturedReason } : {}),
      ...(paint === null ? {} : { paint }),
    };
  });
}
