/**
 * A BRIDGE'S PLOT RECTANGLE AND VALUE AXIS, CHOSEN TOGETHER AND EXACTLY.
 *
 * Three rounds placed a short bar's figure against a PREDICTED plot height and
 * each fix made the next defect. The prediction was wrong whenever a category
 * name was long: ECharts shrank the grid to keep the rotated name inside the
 * box (on the demo, a plot assumed 148px tall drew 123.9), and a figure the
 * domain had made room for was clipped out of the chart.
 *
 * So nothing here predicts:
 *   1. The grid's bottom margin is sized from the longest category name at
 *      its rotation, and the option turns ECharts' shrinking off
 *      (`outerBoundsMode: 'none'`), so the plot ECharts draws IS
 *      `boxPx - top - bottom`. Held by a test that reads the clip rect.
 *   2. The tick count and the label headroom are chosen JOINTLY: the axis is
 *      extended by a label's height past every short bar's end, the step
 *      count is held to the pitch budget, and the two are iterated to a
 *      fixed point where both hold. Bounded; the renderer checks the result
 *      against the real rectangle and has a fallback for the rare state that
 *      does not settle.
 */
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { format } from 'echarts/core';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';
import { axisDomain, type AxisDomain } from './packChartAxes';
import { LABEL_CLEARANCE_PX, LABEL_INSIDE_PX, NIL_STEP_RULE_PX } from './packWaterfallBars';

/**
 * The axis chrome, at the two rungs. `bottom` is the floor for the category
 * names; a name longer than it holds raises it (`categoryDepthPx`).
 *
 * The compact rung sets the names at 10px: "Operating Expenses" rotated
 * thirty degrees stands about 46px tall plus its line, inside 56.
 */
export const WATERFALL_CHROME = {
  full: { top: 32, bottom: 72, labelPx: 12 },
  compact: { top: 20, bottom: 56, labelPx: 10 },
} as const;

/** One gridline step per this many pixels of plot — the pitch at which a
 *  12px tick label is comfortable. */
export const TICK_PITCH_PX = 26;

/** The closest two 12px tick labels may stand: half a line of air between. */
export const MIN_TICK_PITCH_PX = 18;

/** The category names' rotation, and ECharts' gap between axis and name. */
export const CATEGORY_ROTATE_DEG = 30;
const AXIS_LABEL_MARGIN_PX = 8;
/** A browser measures with the face it has loaded, and may set a name a
 *  little wider than zrender's own table does on the server. */
const MEASURE_SLACK_PX = 2;

/**
 * How far below the plot the rotated category names reach — measured with
 * zrender's own text measurer, the one ECharts lays the names out with, so
 * the margin and the drawing agree.
 */
export function categoryDepthPx(names: readonly string[], fontPx: number): number {
  const rad = (CATEGORY_ROTATE_DEG * Math.PI) / 180;
  const font = `${fontPx}px ${PACK_FONT_STACK}`;
  const boxes = names.map((name) => format.getTextRect(name, font));
  const depth = Math.max(0, ...boxes.map((b) => b.width * Math.sin(rad) + b.height * Math.cos(rad)));
  return Math.ceil(AXIS_LABEL_MARGIN_PX + depth + MEASURE_SLACK_PX);
}

export interface WaterfallLayout {
  top: number;
  bottom: number;
  /** The plot's height — exactly the clip rect ECharts draws. */
  plotPx: number;
  domain: AxisDomain;
}

const MAX_PASSES = 16;

/** The pixels each bar's outside label needs past its end, as user values. */
function reachFor(steps: WaterfallStep[], domain: AxisDomain, plotPx: number): number[] {
  const unitsPerPx = (domain.max - domain.min) / plotPx;
  if (!(unitsPerPx > 0)) return [];
  const clearance = (LABEL_CLEARANCE_PX + NIL_STEP_RULE_PX) * unitsPerPx;
  return steps.flatMap((step) => {
    if (Math.abs(step.end - step.start) / unitsPerPx >= LABEL_INSIDE_PX) return [];
    return step.end < step.start
      ? [Math.min(step.start, step.end) - clearance]
      : [Math.max(step.start, step.end) + clearance];
  });
}

/** Whether every outside label has room on its own side of its bar. */
export function labelsFit(steps: WaterfallStep[], domain: AxisDomain, plotPx: number): boolean {
  const reach = reachFor(steps, domain, plotPx);
  return reach.every((v) => v <= domain.max + 1e-9 && v >= domain.min - 1e-9);
}

/**
 * @param askHint The step count the caller budgets for its plot. Absent, the
 *   plot's own budget at `TICK_PITCH_PX`.
 */
export function waterfallLayout(
  steps: WaterfallStep[],
  boxPx: number,
  compact: boolean,
  askHint?: number,
): WaterfallLayout {
  const chrome = compact ? WATERFALL_CHROME.compact : WATERFALL_CHROME.full;
  const bottom = Math.max(chrome.bottom, categoryDepthPx(steps.map((s) => s.label), chrome.labelPx));
  const plotPx = boxPx - chrome.top - bottom;
  // THE ASK IS THE CALLER'S, AND THE BUDGET IS LEGIBILITY. Rounding the step
  // and widening for headroom can each draw more steps than were asked for —
  // asked four, the cash bridge drew six at 17.6px — so whatever is asked,
  // no domain is accepted that puts two ticks closer than
  // `MIN_TICK_PITCH_PX`; the ask is lowered until none does.
  const budget = Math.max(2, Math.floor(plotPx / MIN_TICK_PITCH_PX));
  const ends = steps.flatMap((step) => [step.start, step.end]);

  let ask = Math.min(askHint ?? Math.max(2, Math.floor(plotPx / TICK_PITCH_PX)), budget);
  let reach: number[] = [];
  let domain = axisDomain(ends, ask);
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    domain = axisDomain([...ends, ...reach], ask);
    if (domain.splitNumber > budget && ask > 1) {
      // Rounding the step and the bounds drew more steps than the plot holds:
      // ask for one fewer and start the headroom again on the coarser axis.
      ask -= 1;
      reach = [];
      continue;
    }
    if (labelsFit(steps, domain, plotPx)) break;
    reach = [...reach, ...reachFor(steps, domain, plotPx)];
  }
  return { top: chrome.top, bottom, plotPx, domain };
}
