/**
 * THE FLOOR THAT DRAWS A HAIRLINE HAS TO BE ON THE SHEET.
 *
 * `NIL_STEP_RULE_PX` gives a step whose rect would paint nothing a one-pixel
 * rule on its running total, so the reader gets ink where the line is rather
 * than a label floating above nothing. Measured off Brightsphere's page 6 by
 * the thirty-second visual gate: with 42.84 R'000 per chart unit, Other
 * Income of (1) should occupy 0.023 units and is drawn at 1.0 — a bar at
 * roughly forty times its value while every other bar on the sheet is exact
 * to a tenth of a percent.
 *
 * The floor is the right behaviour: 1 unit is 0.28mm on paper, the mark reads
 * as a hairline, and 0.023 units renders nothing — which the pack's own rule
 * reserves for a nil line. What was wrong is that the rule was undisclosed.
 * The sheet declares the neighbouring rule one clause away ("A line with a nil
 * figure for the period is not drawn"), so a reader measuring that bar against
 * the axis had no way to find the reason on the page.
 *
 * It is derived from what the RENDERER actually floored, not from a second
 * copy of the predicate here: the height that trips the floor is pixels of a
 * plot box this module does not compute, and a re-derivation would agree with
 * the drawing by coincidence.
 */
import { describe, expect, it } from 'vitest';
import { buildProfitWaterfallChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereLiveInput, brightsphereLiveSet, demoSet } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const DECLARATION = 'too small to draw at this scale';

/** Every bar's DRAWN height by category index, straight off the path the
 *  renderer wrote — the same reading `packNilStepIsDrawn` takes. */
function barHeights(svg: string): Map<number, number> {
  const pattern = /<path\b[^>]*d="M[-\d.]+ [-\d.]+l[-\d.]+ 0l0 ([-\d.]+)l[^"]*"[^>]*ecmeta_data_index="(\d+)"[^>]*><\/path>/gi;
  return new Map([...svg.matchAll(pattern)].map((m) => [Number(m[2]), Math.abs(Number(m[1]))]));
}

/** The bridge's own chart and the prose on the sheet that carries it. */
function bridgePage(doc: PackPagesDocument): { floored: string[]; prose: string } {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'chart' || block.chart.kind !== 'waterfall') continue;
      if (block.chart.omittedBars === undefined) continue;
      return {
        floored: block.chart.flooredBars ?? [],
        prose: page.footnotes.map((f) => f.text).join(' '),
      };
    }
  }
  throw new Error('no bridge in this pack');
}

describe('a bar drawn at the floor', () => {
  it('is reported by the chart that drew it', () => {
    const bs = buildProfitWaterfallChart(brightsphereLiveSet, PACK_SCALE);
    // R1 000 against a 5 535 000 span — 0.023 of a chart unit, so only the
    // floor puts a mark at its position.
    expect(brightsphereLiveSet.current.otherIncome, 'this fixture no longer has a sub-pixel line').toBe(-1_000);
    expect(bs.flooredBars, 'the floored bar is not reported').toContain('Other Income');
  });

  /**
   * THE MIRROR CASE, READ OFF THE DRAWING, so the report cannot be satisfied
   * by naming every bar — or the wrong one. A bar the floor grew is drawn at
   * exactly the floor; every other bar is drawn at its own height, which is
   * more than that.
   */
  for (const [company, set] of Object.entries({ 'the demo company': demoSet, Brightsphere: brightsphereLiveSet })) {
    it(`names exactly the bars drawn at the floor on ${company}`, () => {
      const chart = buildProfitWaterfallChart(set, PACK_SCALE);
      const drawn = barHeights(String(chart.svg));
      expect(drawn.size, 'no bars were found in the SVG, so this proves nothing').toBeGreaterThan(2);
      const labels = (chart.waterfallBars ?? []).map((bar) => bar.label);
      const atTheFloor = labels.filter((_, index) => (drawn.get(index) ?? Infinity) <= 1);
      expect(chart.flooredBars ?? []).toEqual(atTheFloor);
    });
  }

  it('is declared on the sheet it is drawn on', () => {
    const { floored, prose } = bridgePage(buildBoardPackPages(brightsphereLiveInput));
    expect(floored.length, 'the live Brightsphere bridge floors nothing, so this proves nothing').toBeGreaterThan(0);
    expect(prose, 'the floor is applied and undeclared').toContain(DECLARATION);
    for (const bar of floored) expect(prose, `${bar} was floored silently`).toContain(bar);
  });

  it('is not declared on a sheet that never applied it', () => {
    const { floored, prose } = bridgePage(buildBoardPackPages(liveDemoShortPanelsInput));
    expect(floored).toEqual([]);
    expect(prose, 'a rule the reader cannot find on the page is declared anyway').not.toContain(DECLARATION);
  });
});
