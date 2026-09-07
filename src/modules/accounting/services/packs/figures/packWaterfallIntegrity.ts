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

import { formatMoney } from '@/lib/format/money';
import type { PackChartSpec, PackWaterfallBar } from '../pages/packPageModel';

/** One cent. Money figures are raw rands (R-P52), so this is absolute. */
export const MONEY_TOLERANCE = 0.01;

const money = (n: number): string => `R${n.toFixed(2)}`;

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

/**
 * WHEN A NAMED PLUG STOPS BEING A RESIDUAL.
 *
 * A named plug beats a hidden one, which is why both bridges carry one. But
 * page 8's plug is R266,000 against a net cash movement of R124,000 — more
 * than twice the thing it is explaining — and a bar that dwarfs its own
 * subject is not a rounding remainder. It is the largest fact on the page,
 * wearing the label of an afterthought, and a reader who takes the bridge as
 * a breakdown of what moved cash has been misled by a chart that foots.
 *
 * THE THRESHOLD IS 10%, and it is a disclosure rather than a refusal.
 *
 * Ten per cent because the conventional audit benchmark for planning
 * materiality is around 5% of profit before tax: a residual at twice that is
 * material on any ordinary test, and one below it is a genuine remainder.
 * Setting it lower would fire on nearly every pack, and a disclosure that
 * appears every time is one readers learn to skip — the same density failure
 * spec §5.7 exists to prevent. Setting it higher would let a plug approaching
 * half the endpoint pass unremarked, which is what page 6 already does.
 *
 * A disclosure, not a refusal, because the plug is a gap in the FIGURE SET,
 * not an error in the pack: no field carries interest and tax, and no field
 * carries the cash reconciling items. Refusing the render would leave a
 * company with an ordinary chart of accounts unable to produce a board pack
 * at all, which punishes the reader for a data-model limit. What the reader
 * is owed is to be told the size of it — so the gate refuses a pack that
 * draws a disproportionate plug WITHOUT saying so, which is enforceable.
 *
 * THE DENOMINATOR is the smaller of two honest readings: the figure the
 * bridge lands on, and the movement it explains. The two bridges are
 * different shapes — page 6 opens on revenue, so its "movement" is
 * R3.7m and would flatter the plug to 6%; page 8 opens on a balance, so its
 * endpoint is R610,000 and would flatter it to 44% rather than 214%. Taking
 * the smaller judges the plug against whichever reading makes it look worse,
 * which is the correct bias for something whose only cost is a sentence.
 */
export const UNCAPTURED_SHARE_LIMIT = 0.1;

/** The plug as a share of what it is plugging, or null where there is none. */
export function uncapturedShare(bars: PackWaterfallBar[]): number | null {
  const plug = bars
    .filter((bar) => bar.uncaptured === true)
    .reduce((sum, bar) => sum + Math.abs(bar.end - bar.start), 0);
  if (plug <= MONEY_TOLERANCE) return null;

  const opening = bars[0]?.end ?? 0;
  const endpoint = bars[bars.length - 1]?.end ?? 0;
  const against = Math.min(Math.abs(endpoint), Math.abs(endpoint - opening));
  // A bridge that lands where it started, or on nothing, is explained
  // ENTIRELY by its plug; there is no proportion to take, and the answer is
  // not "acceptable".
  if (against <= MONEY_TOLERANCE) return Number.POSITIVE_INFINITY;
  return plug / against;
}

/**
 * The sentence a page must carry when its bridge leans on its plug, or null.
 *
 * ONE definition, read by the page that prints it and by the gate that
 * requires it — the same rule `negativeEquitySentence` follows. Two
 * formattings of one mandatory disclosure is how the printed page and the
 * check on it drift apart, and the drift is invisible until the day the
 * disclosure is missing and the gate still passes.
 */
export function disproportionatePlugSentence(chart: PackChartSpec): string | null {
  const bars = chart.waterfallBars;
  if (bars === undefined) return null;
  const share = uncapturedShare(bars);
  if (share === null || share < UNCAPTURED_SHARE_LIMIT) return null;

  const plug = bars.filter((bar) => bar.uncaptured === true);
  const labels = plug.map((bar) => `'${bar.label}'`).join(' and ');
  // `formatMoney`, not the raw `money` above: this sentence is printed on the
  // page, where a director reads it, while the failure messages in this file
  // are read by whoever is fixing the pack and want the unrounded figure.
  const amount = formatMoney(
    plug.reduce((sum, bar) => sum + Math.abs(bar.end - bar.start), 0),
    { symbol: true },
  );
  const pct = Number.isFinite(share) ? `${(share * 100).toFixed(0)}%` : 'more than the whole';
  return (
    `${labels} accounts for ${amount} of this bridge — ${pct} of what ` +
    `it bridges. That step is the movement the figures do not break out, not ` +
    `a measured category, so read the bridge as the shape of the period ` +
    `rather than a complete account of it.`
  );
}
