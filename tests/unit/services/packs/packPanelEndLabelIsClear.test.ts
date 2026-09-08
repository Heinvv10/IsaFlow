/**
 * A RULE STRUCK THROUGH A PRINTED FIGURE.
 *
 * On the rendered demo pack's page 10, the gross-margin panel's end label
 * reads "100.0%" and a grey rule ran across the glyphs — pixel-verified by a
 * blind gate at y≈394 of the raster, and visible in the SVG as a path from
 * x=52 to x=246.1 at y=50.5 under a label centred at y=49.9 and starting at
 * x=221.8. Two rules do it: the top gridline, because that panel's last
 * point IS its maximum, and the category axis line, which ECharts draws at
 * zero wherever the domain spans it.
 *
 * IT WAS NEVER ONE PANEL. The debtor-days panel ends on its own maximum too
 * and its top gridline crosses "60 days" identically, in the lighter ink the
 * gate did not catch. Any panel whose last point is an extreme has it, which
 * is why the fix is geometric — `boundaryGap: false`, so the series ends at
 * the plot edge and the label sits in the 64px gutter the grid already
 * reserves for it — and why this test is a property of every panel rather
 * than an assertion about that one.
 *
 * Measured off the painted SVG. The rules ARE drawn at these coordinates and
 * the label IS set at that x; a rule whose span reaches the label's first
 * glyph is overprinting, which is what the criterion calls the sort of thing
 * a director photographs and forwards.
 */
import { describe, expect, it } from 'vitest';
import { buildTrendPanels } from '@/modules/accounting/services/packs/pages/packTrendCharts';
import { buildCashTrendChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { liveDemoTrend } from './fixtures/liveDemoBoardPack';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

/** A horizontal rule the panel paints: gridlines and the category axis line
 *  are single-segment `M x1 y L x2 y` paths, so a rule is one whose two ends
 *  share a y. Anything else — the series polyline, the clip rect — is not. */
interface Rule { x1: number; x2: number; y: number }

function horizontalRules(svg: string): Rule[] {
  const out: Rule[] = [];
  for (const match of svg.matchAll(/<path d="M([-\d.]+) ([-\d.]+)L([-\d.]+) ([-\d.]+)"/g)) {
    const [x1, y1, x2, y2] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
    if (y1 === y2) out.push({ x1: Math.min(x1!, x2!), x2: Math.max(x1!, x2!), y: y1! });
  }
  return out;
}

/**
 * The series' END LABEL — the one text drawn in the ink colour rather than in
 * the axis grey.
 *
 * It is anchored at its START in a panel, where it sits in the 80px gutter
 * to the right of the plot, and at its END on the full-width line, where the
 * gutter was given back to the plot so the chart would end on the page's own
 * measure. Both anchors count; matching only `start` selected nothing on the
 * full-width line and reported "paints no end label", which is a test going
 * green-adjacent on a chart it had stopped looking at.
 *
 * Picked by its fill rather than by its content: the label's text is the
 * panel's own unit through the panel's own formatter, so matching a string
 * would select nothing the day a formatter changes, which is a green test
 * asserting an empty list.
 */
interface EndLabel { x: number; y: number; size: number; text: string; anchor: 'start' | 'end' }

function endLabel(svg: string): EndLabel | null {
  for (const match of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = match[1] ?? '';
    if (!/text-anchor="(?:start|end)"/.test(attrs) || !/fill="#15202b"/.test(attrs)) continue;
    const position = /transform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(attrs);
    const size = /font-size:([\d.]+)px/.exec(attrs);
    const anchor = /text-anchor="(start|end)"/.exec(attrs);
    if (position === null || size === null || anchor === null) continue;
    return {
      x: Number(position[1]),
      y: Number(position[2]),
      size: Number(size[1]),
      text: match[2] ?? '',
      anchor: anchor[1] as 'start' | 'end',
    };
  }
  return null;
}

/**
 * A trend whose last month is every panel's own extreme — the shape that
 * puts the end label on a gridline. The live demo series does it on two
 * panels by accident; this makes it true of all of them, so the property is
 * exercised rather than sampled.
 */
const endsOnItsExtreme: PackTrendPoint[] = liveDemoTrend.map((point, i, all) => ({
  ...point,
  revenue: 100_000 + i * 10_000,
  costOfSales: 40_000 + i * 1_000,
  // THE RATIO PANELS PLOT THREE MONTHS, as they do on the pack the gate
  // read: a ratio panel drops the months it cannot measure, and the demo
  // company posts turnover in three of twelve. That is what makes the gap
  // matter — a category band is a twelfth of the plot over twelve points and
  // a third of it over three, so the half-band reserved at the end runs from
  // eight pixels to thirty-two. Twelve-point panels alone put the rule's end
  // within a pixel of the label's first glyph, which is an overprint the
  // arithmetic can only just see.
  grossMarginPct: i >= all.length - 3 ? 40 + i : null,
  debtorDays: i >= all.length - 3 ? 10 + i * 4 : null,
  cash: 5_000 * (i + 1),
  netProfit: 1_000 * (i + 1),
  expenses: 20_000 + i * 500,
  partial: i === all.length - 1 ? point.partial : point.partial,
}));

/**
 * The paper-coloured ground the full-width line's label is set on.
 *
 * ECharts draws a label background as its own filled rect, so the ground is
 * present in the markup or it is not — and if it is not, a gridline running
 * under an in-plot label prints through it.
 */
function paintsItsOwnGround(svg: string): boolean {
  return /<(?:rect|path)[^>]*fill="#ffffff"/.test(svg);
}

function assertClear(id: string, svg: string): void {
  const label = endLabel(svg);
  expect(label, `${id} paints no end label`).not.toBeNull();
  // IN THE PLOT, THE GROUND IS THE GUARANTEE. A label in the right-hand
  // gutter is kept off the gridlines by geometry; the full-width line gave
  // that gutter back to the plot so the chart would end on the page's
  // measure, and inside the plot every gridline runs under the label. An
  // opaque ground is what keeps the figure readable there — so that is what
  // is asserted, rather than a clearance the geometry no longer provides.
  if (label!.anchor === 'end') {
    expect(paintsItsOwnGround(svg), `${id}: an in-plot end label with no ground behind it`).toBe(true);
    return;
  }
  for (const rule of horizontalRules(svg)) {
    // Vertically clear of the label's own type, or horizontally short of its
    // first glyph. Either is enough; neither being true is a strike-through.
    const overlapsVertically = Math.abs(rule.y - label!.y) < label!.size * 0.6;
    if (!overlapsVertically) continue;
    expect(
      rule.x2,
      `${id}: a rule at y=${rule.y} runs to x=${rule.x2}, through the end label `
      + `"${label!.text}" set at x=${label!.x}`,
    ).toBeLessThanOrEqual(label!.x);
  }
}

describe('a trend panel never draws a rule through its own end label', () => {
  it('holds on every panel of a series that ends on its own extreme', () => {
    const { panels } = buildTrendPanels(endsOnItsExtreme, PACK_SCALE);
    expect(panels.length, 'no panel drawn, so nothing is being tested').toBeGreaterThan(0);
    // NOT VACUOUS: at least one panel must actually end on a gridline, or
    // every assertion below is about a label nowhere near a rule.
    const onARule = panels.filter((panel) => {
      const label = endLabel(panel.svg);
      return label !== null
        && horizontalRules(panel.svg).some((r) => Math.abs(r.y - label.y) < label.size * 0.6);
    });
    expect(onARule.map((p) => p.id), 'no panel ends level with a rule').not.toEqual([]);
    for (const panel of panels) assertClear(panel.id, panel.svg);
  });

  it('holds on the live series the pack renders', () => {
    const { panels } = buildTrendPanels(liveDemoTrend, PACK_SCALE);
    for (const panel of panels) assertClear(panel.id, panel.svg);
  });

  /** The full-width cash line on page 8 takes the same option builder, with
   *  the unit axis rather than the endpoint one, so it inherits the same
   *  geometry and the same guarantee. */
  it('holds on the full-width cash line', () => {
    const chart = buildCashTrendChart(liveDemoTrend, PACK_SCALE);
    assertClear(chart.id, chart.svg);
  });
});
