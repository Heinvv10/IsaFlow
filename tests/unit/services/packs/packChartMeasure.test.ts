/**
 * EVERY FULL-WIDTH CHART IS DRAWN ON THE PAGE'S OWN MEASURE.
 *
 * Three charts sit under a table on three sheets of the pack, and all three
 * were drawn on different measures — the profit bridge at 722 rendered pixels
 * on the demo company and 714 on Brightsphere, the cash line 51 short of the
 * table rule directly above it. Two separate causes, both invisible to
 * anything that read a constant instead of the drawing:
 *
 *  - the SVG was rendered at the FIGURE's height and given the height the
 *    caption spared, so `preserveAspectRatio`'s default scaled it down and
 *    centred it — by an amount that varied with how many lines the title
 *    wrapped to, which is why the same chart measured differently on two
 *    companies (`packChartBox.ts`, `PackChartBlock`);
 *  - the last category label was centred on the last point, so ECharts
 *    shrank the plot to keep it inside — by half that label's width, which
 *    is content again (`alignMaxLabel` in `packLineChartOptions.ts`).
 *
 * This test reads the painted SVG. A gridline is a two-point horizontal path
 * spanning the plot, so the plot's right edge is the largest x any of them
 * reaches; the SVG's own width is the measure it was given. The two must
 * agree to `AXIS_END_LABEL_RESERVE_PX` — ECharts' fixed reserve on a
 * labelled category axis, which no grid setting reclaims — and must agree
 * ACROSS COMPANIES, which is the half of it a single-company render cannot
 * see.
 *
 * EXCEPT BY THE CASH LINE'S END-LABEL GUTTER. Page 8's closing figure sits in
 * a gutter right of the plot, sized to the figure (`packEndLabelGutter`), so
 * that chart's plot ends that gutter short of the measure — and no further:
 * the allowance is the figure's own width, measured here and not by the
 * function under test.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { AXIS_END_LABEL_RESERVE_PX } from '@/modules/accounting/services/packs/packChartOptions';
import { PX_PER_MM } from '@/lib/charts/ssrSvg';
import { glyphCells } from './support/bridgeSvg';
import type { PackChartSpec } from '@/modules/accounting/services/packs/pages/packChartModel';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';

/** Every chart that is drawn across the full text measure — the ones with a
 *  table above them, which is the comparison a reader actually makes. */
function fullWidthCharts(doc: PackPagesDocument): PackChartSpec[] {
  const out: PackChartSpec[] = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind === 'chart') out.push(block.chart);
    }
  }
  return out;
}

/** The gap page 8 leaves between the line's last point and its closing figure. */
const END_LABEL_GAP_PX = 6;
/** Rounding, and a pixel or two of spare. */
const GUTTER_SLACK_PX = 4;
/** However long the closing figure, the plot keeps this much of the measure. */
const MAX_GUTTER_SHARE = 0.2;

/**
 * What a chart may stop short of its SVG's right edge: the axis reserve, or
 * on the cash line the gutter its closing figure needs.
 *
 * BOUNDED INDEPENDENTLY of the function that sizes the gutter: the figure is
 * read off the SVG — the one text set in ink — and measured by the face's own
 * advances (`glyphCells`), so a gutter that grew for any other reason is
 * caught; and it may never take more than a fifth of the measure.
 */
function allowedShortPx(chart: PackChartSpec): number {
  if (chart.id !== 'cash-trend') return AXIS_END_LABEL_RESERVE_PX;
  const svg = chart.svg as unknown as string;
  const label = /<text[^>]*text-anchor="start"[^>]*fill="#15202b"[^>]*>([^<]*)<\/text>/.exec(svg);
  expect(label, 'the cash line prints no closing figure').not.toBeNull();
  const cells = glyphCells(label![1]!.replace(/&#39;/g, "'"), 0);
  const allowed = END_LABEL_GAP_PX + (cells[cells.length - 1]!.right - cells[0]!.left) + GUTTER_SLACK_PX;
  expect(allowed, 'the closing figure takes more than a fifth of the measure').toBeLessThanOrEqual(svgWidthPx(svg) * MAX_GUTTER_SHARE);
  return allowed;
}

/** The plot's right edge, off the painted gridlines. */
function plotRightPx(svg: string): number {
  const xs = [...svg.matchAll(/<path d="M([-\d.]+) ([-\d.]+)L([-\d.]+) \2"/g)]
    .map((m) => Math.max(Number(m[1]), Number(m[3])));
  expect(xs.length, 'no horizontal rule in the chart, so nothing is measured').toBeGreaterThan(0);
  return Math.max(...xs);
}

function svgHeightPx(svg: string): number {
  const height = /<svg width="\d+" height="(\d+)"/.exec(svg);
  expect(height, 'chart SVG carries no height').not.toBeNull();
  return Number(height![1]);
}

function svgWidthPx(svg: string): number {
  const width = /<svg width="(\d+)"/.exec(svg);
  expect(width, 'chart SVG carries no width').not.toBeNull();
  return Number(width![1]);
}

const COMPANIES = {
  'the demo company': liveDemoRenderedInput,
  Brightsphere: brightsphereLiveInput,
};

describe('a full-width chart is drawn on the page measure', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`spans its own SVG on ${company}`, () => {
      const charts = fullWidthCharts(buildBoardPackPages(input));
      expect(charts.length, 'no full-width chart drawn, so nothing is tested').toBeGreaterThan(0);
      for (const chart of charts) {
        const short = svgWidthPx(chart.svg as unknown as string) - plotRightPx(chart.svg as unknown as string);
        expect(short, `${chart.id} stops ${short}px short of its own measure`)
          .toBeLessThanOrEqual(allowedShortPx(chart));
      }
    });
  }

  it('draws the same chart on the same measure for both companies', () => {
    const measures = Object.entries(COMPANIES).map(([company, input]) => {
      const byId = new Map<string, number>();
      for (const chart of fullWidthCharts(buildBoardPackPages(input))) {
        // Measured to the plot plus the gutter it is allowed, so the cash
        // line compares on the measure it actually shares.
        byId.set(chart.id, plotRightPx(chart.svg as unknown as string) + allowedShortPx(chart) - AXIS_END_LABEL_RESERVE_PX);
      }
      return { company, byId };
    });
    const [a, b] = measures;
    const shared = [...a!.byId.keys()].filter((id) => b!.byId.has(id));
    expect(shared, 'the two packs share no full-width chart, so nothing is compared').not.toEqual([]);
    for (const id of shared) {
      // The cash line's gutter is rounded up to a whole pixel round a figure
      // of its own width, so its edge agrees to that pixel; the rest exactly.
      const apart = Math.abs(b!.byId.get(id)! - a!.byId.get(id)!);
      expect(apart, `${id} is drawn to a different right edge on the two companies`)
        .toBeLessThanOrEqual(id === 'cash-trend' ? 1 : 0);
    }
  });

  it('renders at the height the stylesheet will give it', () => {
    // THE OTHER HALF OF THE MEASURE. The plot's right edge inside the SVG is
    // only the page's measure if the SVG is not scaled on the way to paper —
    // and `.pack-chart-svg` is sized from `plotMm`, so an SVG rendered at any
    // other height is letterboxed: scaled down uniformly and CENTRED, which
    // takes width off the chart in proportion to the difference. `plotMm` is
    // therefore a claim about the drawing, and this is the claim checked.
    for (const [company, input] of Object.entries(COMPANIES)) {
      for (const chart of fullWidthCharts(buildBoardPackPages(input))) {
        const renderedMm = svgHeightPx(chart.svg as unknown as string) / PX_PER_MM;
        expect(
          Math.abs(renderedMm - chart.plotMm),
          `${company}: ${chart.id} is drawn at ${renderedMm.toFixed(2)}mm and boxed at ${chart.plotMm.toFixed(2)}mm`,
        ).toBeLessThan(0.5);
      }
    }
  });

  it('does not move when the caption grows', () => {
    // The defect's own signature: the plot narrowed as the title wrapped, so
    // a longer caption is what has to leave the measure alone.
    const doc = buildBoardPackPages(liveDemoRenderedInput);
    const charts = fullWidthCharts(doc);
    const titles = charts.map((c) => c.title.length);
    expect(Math.max(...titles) - Math.min(...titles), 'every caption is the same length here')
      .toBeGreaterThan(20);
    for (const c of charts) {
      expect(svgWidthPx(c.svg as unknown as string) - plotRightPx(c.svg as unknown as string)).toBeLessThanOrEqual(allowedShortPx(c));
    }
  });
});
