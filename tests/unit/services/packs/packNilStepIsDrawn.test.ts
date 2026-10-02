/**
 * A NIL STEP ON A BRIDGE HAS TO BE DRAWN WHERE IT HAPPENS.
 *
 * Brightsphere's page 6 bridge has a nil cost-of-sales step. It spans zero
 * user units, so its rect was zero pixels tall and painted nothing at all —
 * and the only mark the reader got was its `–` label, which the renderer sets
 * a line of type ABOVE the bar. Measured off the raster by the eleventh
 * visual gate: with the zero line at y=818 and 21.25px per R1m, that dash
 * landed at y=923.5, ON THE (5 000) GRIDLINE, while the running total it
 * belongs to sat at y=935.6. There was no bar, no tick and no connector at
 * the true position. The table two inches above the same chart says nil, so
 * any director reading the bridge against its axis took a cost of sales of
 * about five million off a page whose table says there is none.
 *
 * This is measured off the emitted SVG in the same way `packWaterfallLegibility`
 * measures the labels: the geometry, not a claim about it.
 *
 * THE NIL STEP IS NO LONGER DRAWN AT ALL — one rule for a line with no
 * figure, because the bridge used to drop a nil Other Expenses and keep a nil
 * Cost of Sales, so two companies' page 6 drew six bars and seven off the
 * same statement (`withoutNilMovements`, and page 6 names what it left out from the same return value). That
 * settles the misplaced dash by removing the mark, and it does NOT settle the
 * floor: a step of a few hundred rand against a five-million axis still
 * rounds to a rect under a pixel, and the floor is the only thing that puts
 * ink at its position. So the floor keeps its test, on a step small enough to
 * need it, and the nil case asserts the absence instead.
 */
import { describe, expect, it } from 'vitest';
import { buildProfitWaterfallChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import { brightsphereSet } from './fixtures/boardPackInputs';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';

/** Every bar the renderer emitted: its category index, its top and its
 *  drawn height, straight off the path the renderer wrote.
 *
 *  NOT the paper ground drawn under a label that sits clear of its bar — see
 *  `LABEL_KNOCKOUT_PAD_PX`. That is a rect in the same group with the same
 *  `ecmeta_data_index`, and taking it for the bar reads a step's top off a
 *  label's box. A bar is never filled in paper: `stepColour` returns an ink,
 *  a favourable or an unfavourable, and the ground is the one white rect. */
function bars(svg: string): Array<{ index: number; top: number; height: number }> {
  const pattern = /<path\b[^>]*d="M([-\d.]+) ([-\d.]+)l[-\d.]+ 0l0 ([-\d.]+)l[^"]*"[^>]*fill="(#[0-9a-f]{6})"[^>]*ecmeta_data_index="(\d+)"[^>]*><\/path>/gi;
  return [...svg.matchAll(pattern)]
    .filter((m) => m[4]!.toLowerCase() !== DEFAULT_CHART_PALETTE.paper.toLowerCase())
    .map((m) => ({
      index: Number(m[5]),
      top: Number(m[2]),
      height: Number(m[3]),
    }));
}

/** Brightsphere's own figures with a cost of sales of R400 — three ten-
 *  thousandths of the revenue bar beside it, so its rect is well under a
 *  pixel tall and only the floor puts a mark at its position. */
const tinyStepSet: PackFigureSet = {
  ...brightsphereSet,
  current: { ...brightsphereSet.current, costOfSales: 400 },
};

describe('a nil step on a bridge', () => {
  const chart = buildProfitWaterfallChart(tinyStepSet, PACK_SCALE);
  const svg = String(chart.svg);
  const drawn = bars(svg);

  it('paints ink at the running total rather than nothing at all', () => {
    // Not vacuous: a pattern that matched nothing would pass the loop below.
    expect(drawn.length, 'no bars were found in the SVG').toBeGreaterThan(2);

    for (const bar of drawn) {
      expect(
        Math.abs(bar.height),
        `bar ${bar.index} is drawn ${bar.height}px tall, so the only mark on the sheet at its `
          + 'position is a label the renderer sets a line of type above it — which is how a nil '
          + 'cost of sales came to be read off the (5 000) gridline',
      ).toBeGreaterThanOrEqual(1);
    }
  });

  /**
   * AND THE RULE IS ON THE RUNNING TOTAL, not merely somewhere.
   *
   * A floor applied to the wrong coordinate — growing the bar downward from
   * its own top, say — would satisfy the height assertion above and still
   * draw the mark in the wrong place. Brightsphere's cost-of-sales step
   * follows a revenue bar of (5 535), so the nil step's rule must sit at that
   * bar's far end, within the one pixel the floor itself adds.
   */
  it('puts the rule at the end of the step before it', () => {
    const revenue = drawn.find((b) => b.index === 0)!;
    const costOfSales = drawn.find((b) => b.index === 1)!;
    expect(costOfSales, 'no second bar, so the position below is untested').toBeDefined();
    // The revenue bar runs from zero DOWN to (5 535), so its running total is
    // the lower edge; a zero-height step starts and ends there.
    const runningTotal = revenue.top + Math.abs(revenue.height);
    expect(
      Math.abs(costOfSales.top - runningTotal),
      `the sub-pixel step is drawn at y=${costOfSales.top} and the running total it belongs to is at `
        + `y=${runningTotal}`,
    ).toBeLessThanOrEqual(1);
  });

  it('does not draw a line the period has no figure for', () => {
    const nil = buildProfitWaterfallChart(brightsphereSet, PACK_SCALE);
    expect(brightsphereSet.current.costOfSales, 'this fixture no longer has a nil line to omit').toBe(0);
    expect(nil.omittedBars, 'a nil cost of sales was still drawn').toContain('Cost of Sales');
    expect((nil.waterfallBars ?? []).map((b) => b.label)).not.toContain('Cost of Sales');
  });
});
