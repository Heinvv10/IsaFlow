/**
 * CAN A DIRECTOR READ THE Y-AXIS?
 *
 * Page 7's composition bar steps down a rung when total assets are negative,
 * to make room for the disclosure that says so. The first version of that
 * step-down went to the BOTTOM rung — 48mm — and on the live demo figures,
 * whose axis runs 4 000 to (5 000), the eleven tick labels had about 7.7px
 * between their centres at a 12px font: `(1 000)`, `(2 000)` and `(3 000)`
 * printed on top of one another. The page still ended with a quarter-sheet of
 * white, so the height was never the page's to take.
 *
 * Overlapping axis labels are the visual signature of an unfinished chart,
 * and no test in the suite could see them: the sheet count passed, the model
 * was correct, and the chart is an opaque SVG string to every other check.
 *
 * This reads the SVG the pack actually carries and measures the gap between
 * neighbouring tick labels. It is not a proxy for the picture — the labels
 * ARE laid out at these coordinates, at this font size, and two of them
 * closer together than their own type is exactly what overprinting is.
 */
import { describe, expect, it } from 'vitest';
import { buildPositionCompositionChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { CHART_HEIGHT_MM } from '@/lib/charts/ssrSvg';
import { brightsphereSet, demoSet } from './fixtures/boardPackInputs';
import { liveDemoSet } from './fixtures/liveDemoBoardPack';

/**
 * Every `<text>` in the SVG, as a font size and the y it is centred on.
 *
 * zrender emits the position in a `transform="translate(x y)"` and the size
 * in an inline `style`, so both come off the same element and neither is
 * assumed.
 */
interface Label { x: number; y: number; size: number; text: string }

function labels(svg: string): Label[] {
  const out: Label[] = [];
  for (const match of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = match[1] ?? '';
    const position = /transform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(attrs);
    const size = /font-size:([\d.]+)px/.exec(attrs);
    if (position === null || size === null) continue;
    out.push({
      x: Number(position[1]),
      y: Number(position[2]),
      size: Number(size[1]),
      text: (match[2] ?? '').replace(/&#39;/g, "'"),
    });
  }
  return out;
}

/**
 * The value-axis ticks: the labels sharing the x the axis draws them at.
 *
 * Picked by the column they occupy rather than by matching their text — the
 * axis formatter is `formatMoney`, so a tick reads `(3 000)` or `–` and a
 * text match would quietly select nothing the day the formatter changes,
 * which is a green test asserting an empty list.
 */
function yAxisTicks(svg: string): Label[] {
  const all = labels(svg);
  const byColumn = new Map<number, Label[]>();
  for (const label of all) {
    const column = byColumn.get(label.x) ?? [];
    column.push(label);
    byColumn.set(label.x, column);
  }
  const ticks = [...byColumn.values()].reduce((a, b) => (b.length > a.length ? b : a), []);
  return [...ticks].sort((a, b) => a.y - b.y);
}

/** The smallest distance between two neighbouring ticks' centres. */
function tightestGap(ticks: Label[]): number {
  let tightest = Infinity;
  for (let i = 1; i < ticks.length; i += 1) {
    tightest = Math.min(tightest, ticks[i]!.y - ticks[i - 1]!.y);
  }
  return tightest;
}

const CASES: Array<[string, typeof demoSet]> = [
  ['the live demo company (negative assets, the stepped-down chart)', liveDemoSet],
  ['the demo company (positive assets, full height)', demoSet],
  ['Brightsphere (positive assets, negative equity)', brightsphereSet],
];

describe("page 7's composition chart", () => {
  for (const [name, set] of CASES) {
    it(`prints a legible y-axis for ${name}`, () => {
      const chart = buildPositionCompositionChart(set, PACK_SCALE);
      const ticks = yAxisTicks(String(chart.svg));

      // Not vacuous: an axis with one tick has no gap to be too small.
      expect(ticks.length, 'no y-axis tick labels were found in the SVG').toBeGreaterThan(2);

      const size = ticks[0]!.size;
      const gap = tightestGap(ticks);
      expect(
        gap,
        `two tick labels are ${gap.toFixed(1)}px apart at ${size}px type — `
          + `${ticks.map((t) => t.text).join(' / ')}`,
      ).toBeGreaterThanOrEqual(size);
    });
  }

  /**
   * AND THE STEP-DOWN IS TO THE MIDDLE RUNG, NOT THE BOTTOM ONE.
   *
   * The gap check above is what matters to a reader, but it is satisfied by a
   * chart that never steps down at all — so this pins the other half: the
   * page 7 disclosure still gets its room.
   */
  it('gives a rung back where total assets are negative, and only one', () => {
    expect(liveDemoSet.current.totalAssets, 'this fixture is the negative-assets case').toBeLessThan(0);
    expect(demoSet.current.totalAssets, 'and this one is not').toBeGreaterThan(0);

    expect(buildPositionCompositionChart(liveDemoSet, PACK_SCALE).heightMm).toBe(CHART_HEIGHT_MM.half);
    expect(buildPositionCompositionChart(demoSet, PACK_SCALE).heightMm).toBe(CHART_HEIGHT_MM.full);
  });
});
