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
 */
import { describe, expect, it } from 'vitest';
import { buildProfitWaterfallChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { brightsphereSet } from './fixtures/boardPackInputs';

/** Every bar the renderer emitted: its category index, its top and its
 *  drawn height, straight off the path the renderer wrote. */
function bars(svg: string): Array<{ index: number; top: number; height: number }> {
  const pattern = /<path\b[^>]*d="M([-\d.]+) ([-\d.]+)l[-\d.]+ 0l0 ([-\d.]+)l[^"]*"[^>]*ecmeta_data_index="(\d+)"[^>]*><\/path>/gi;
  return [...svg.matchAll(pattern)].map((m) => ({
    index: Number(m[4]),
    top: Number(m[2]),
    height: Number(m[3]),
  }));
}

describe('a nil step on a bridge', () => {
  const svg = String(buildProfitWaterfallChart(brightsphereSet, PACK_SCALE).svg);
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
    // The revenue bar runs from zero DOWN to (5 535), so its running total is
    // the lower edge; a zero-height step starts and ends there.
    const runningTotal = revenue.top + Math.abs(revenue.height);
    expect(
      Math.abs(costOfSales.top - runningTotal),
      `the nil step is drawn at y=${costOfSales.top} and the running total it belongs to is at `
        + `y=${runningTotal}`,
    ).toBeLessThanOrEqual(1);
  });
});
