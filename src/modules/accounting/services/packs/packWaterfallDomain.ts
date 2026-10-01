/**
 * A BRIDGE'S VALUE AXIS, WITH ROOM FOR EVERY FIGURE ON ITS OWN SIDE.
 *
 * A bar too short to hold its figure prints it outside — above a rising bar,
 * below a falling one — and the domain was rounded out from the BARS alone,
 * so a short bar at the extreme of the chart left its figure no room: the
 * demo's Revenue of 101 ended a few pixels under a domain top of 200, and the
 * renderer's answer was to move the figure under the zero line, where it
 * reads as a negative. The axis is extended by a label's height past each
 * such bar's end before the ticks are chosen, so the figure keeps its side.
 *
 * The extension is in user units and depends on the domain it extends, so it
 * is settled by repeating until the rounded domain stops moving — two or three
 * passes, since each pass can only widen the span to the next round step.
 */
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { axisDomain, type AxisDomain } from './packChartAxes';
import { LABEL_CLEARANCE_PX, LABEL_INSIDE_PX } from './packWaterfallBars';

const MAX_PASSES = 4;

/**
 * @param plotPx The plot's height in pixels — the SVG box less the grid's top
 *   and bottom — which is what converts a label's height into user units.
 */
export function labelledDomain(steps: WaterfallStep[], intervals: number, plotPx: number): AxisDomain {
  const ends = steps.flatMap((step) => [step.start, step.end]);
  let domain = axisDomain(ends, intervals);
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const unitsPerPx = (domain.max - domain.min) / plotPx;
    if (!(unitsPerPx > 0)) return domain;
    const reach = steps.flatMap((step) => {
      // A bar tall enough to hold its figure carries it inside: nothing to
      // make room for.
      if (Math.abs(step.end - step.start) / unitsPerPx >= LABEL_INSIDE_PX) return [];
      const clearance = LABEL_CLEARANCE_PX * unitsPerPx;
      return step.end < step.start
        ? [Math.min(step.start, step.end) - clearance]
        : [Math.max(step.start, step.end) + clearance];
    });
    const next = axisDomain([...ends, ...reach], intervals);
    if (next.min === domain.min && next.max === domain.max) return next;
    domain = next;
  }
  return domain;
}
