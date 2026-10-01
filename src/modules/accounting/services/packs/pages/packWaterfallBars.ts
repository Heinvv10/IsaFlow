/**
 * What the pack's two bridges share: how many gridline steps a box has room
 * for, and the `PackWaterfallBar`s that mirror what is drawn so the integrity
 * gate can walk the bridge. Split out of `packPageCharts.ts` for the 300-line
 * cap.
 */
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { CHART_HEIGHT_MM } from '@/lib/charts/ssrSvg';
import { stepPaint, waterfallChromePx } from '@/modules/accounting/services/packs/packChartOptions';
import type { PackWaterfallBar, PlugReason } from './packPageModel';

/**
 * HOW MANY GRIDLINE STEPS THIS BOX HAS ROOM FOR.
 *
 * `waterfallOption` defaults to six, which suits the 110mm rung and
 * overprints on the 48mm one: the demo cash bridge drew seven tick labels
 * with 11.8px between their centres at 12px type. The plot is the box less
 * `grid.top` and `grid.bottom`, which `waterfallChromePx` reports because
 * the bottom rung draws them tighter, and 26px is
 * comfortable for a 12px label — the same measure `packChartAxisLegibility`
 * asserts against on the printed SVG.
 */
export const PX_PER_MM = 96 / 25.4;
const TICK_PITCH_PX = 26;

/** The bottom rung, where the bridge draws its axis chrome tighter and its
 *  category labels a size smaller — see `WATERFALL_CHROME`. */
export function isCompact(box: { heightMm: number }): boolean {
  return box.heightMm <= CHART_HEIGHT_MM.inline;
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
