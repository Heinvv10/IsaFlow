/**
 * Does a bridge chart's bars actually reach the endpoint its title claims?
 *
 * A waterfall is the one chart in a board pack that makes an ARITHMETIC
 * assertion: revenue, less these steps, IS net profit. The rectangles are
 * drawn from `start` and `end` per bar, so a bridge whose steps do not add up
 * still draws — it draws a final bar floating away from the chain, which
 * reads as a rounding artefact rather than as the missing R223,000 it is.
 * `PackChartSpec.waterfallBars` mirrors what was drawn precisely so this can
 * be checked as numbers instead of by re-parsing an SVG.
 *
 * THE SUBTOTAL BAR (R-P50). A statement bridge resets at each mid-statement
 * subtotal — Gross Profit is drawn from the axis (`start: 0`), not from the
 * cost-of-sales bar it follows. Walking `start === previous end` across such a
 * bar reports a break in an HONEST chart, and a gate that fails correct packs
 * is one everybody learns to bypass. A subtotal is therefore checked the other
 * way round: its `end` must equal what the chain accumulated to, which is the
 * assertion the drawn bar is actually making.
 *
 * The named plug is deliberate and must pass. Page 8's cash bridge draws an
 * `Unexplained movement` step because the figure set carries no reconciling
 * items; page 6's profit bridge draws `Other, not separately captured` for the
 * interest and tax between operating profit and net profit. Both foot BECAUSE
 * of a bar a director can see and question. What this refuses is the other
 * thing — a bridge that simply does not reach its own closing bar and says
 * nothing about the gap.
 */

import type { PackChartSpec, PackWaterfallBar } from '../pages/packPageModel';

/** One cent. Money figures are raw rands (R-P52), so this is absolute. */
export const MONEY_TOLERANCE = 0.01;

const money = (n: number): string => n.toFixed(2);

/** Every failure in this bridge, as sentences. Empty means the bridge foots. */
export function checkWaterfall(chart: PackChartSpec): string[] {
  const failures: string[] = [];
  const bars: PackWaterfallBar[] | undefined = chart.waterfallBars;

  if (bars === undefined || bars.length === 0) {
    return [
      `Waterfall chart '${chart.id}' carries no bars. The bridge it draws ` +
        `cannot be checked against its endpoints, and an unverifiable bridge ` +
        `on a board pack is refused rather than trusted.`,
    ];
  }

  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  if (first.kind !== 'open') {
    failures.push(
      `Waterfall '${chart.id}' opens on a '${first.kind}' bar ('${first.label}'). ` +
        `A bridge starts from a stated opening position.`,
    );
  }
  if (last.kind !== 'close') {
    failures.push(
      `Waterfall '${chart.id}' ends on a '${last.kind}' bar ('${last.label}'). ` +
        `A bridge closes on the endpoint it claims to reach.`,
    );
  }

  // The chain, walked bar by bar. `null` until an opening bar states where
  // the bridge starts — a chain with no stated start has no arithmetic to
  // check, and assuming zero would invent the very endpoint under test.
  let running: number | null = null;

  for (const bar of bars) {
    if (bar.kind === 'open') {
      running = bar.end;
      continue;
    }
    if (running === null) {
      failures.push(
        `Waterfall '${chart.id}' bar '${bar.label}' continues a bridge that ` +
          `never opened. Nothing states where the chain begins.`,
      );
      continue;
    }
    if (bar.kind === 'increase' || bar.kind === 'decrease') {
      if (Math.abs(bar.start - running) > MONEY_TOLERANCE) {
        failures.push(
          `Waterfall '${chart.id}' bar '${bar.label}' starts at ` +
            `${money(bar.start)} but the bars before it accumulate to ` +
            `${money(running)}. The bridge is broken at that step.`,
        );
      }
      running = bar.end;
      continue;
    }
    // 'subtotal' and 'close': drawn from the axis, so `start` says nothing.
    // What the bar ASSERTS is its end, and the chain must have reached it.
    if (Math.abs(bar.end - running) > MONEY_TOLERANCE) {
      failures.push(
        `Waterfall '${chart.id}' does not foot: the bars accumulate to ` +
          `${money(running)} but '${bar.label}' states ${money(bar.end)}. A ` +
          `gap of ${money(bar.end - running)} is unaccounted for — if it is ` +
          `real, draw it as its own named step so a reader can see it.`,
      );
    }
    running = bar.end;
  }

  return failures;
}
