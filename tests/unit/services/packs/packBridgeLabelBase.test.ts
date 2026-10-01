/**
 * A FIGURE IS ON ITS BAR'S OWN SIDE OF THE BASE, ON EVERY BRIDGE.
 *
 * A rising bar's figure never sits below its base, and a falling bar's never
 * above it — the side a label is on is read as the sign of the movement. The
 * demo's page 6 printed Revenue's "101" UNDER the zero line beneath its
 * green bar: the bar was short, the domain ended a few pixels above it, and
 * the rule for a label with no room was to move it to the other side. The
 * fix is room, not the other side: the value axis is extended by a label's
 * height wherever a short bar's figure needs it.
 */
import { describe, expect, it } from 'vitest';
import { buildProfitWaterfallChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import { labelInkOn, waterfallOption } from '@/modules/accounting/services/packs/packChartOptions';
import { waterfallLayout } from '@/modules/accounting/services/packs/packWaterfallDomain';
import { PX_PER_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import { barOf, clipRect, figures, outsideClip, overOwnBar, wrongSide } from './support/bridgeSvg';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { liveDemoSet } from './fixtures/liveDemoBoardPack';
import { yAxisTicks } from './support/svgTicks';

interface Rect { centre: number; top: number; bottom: number }
interface Label { x: number; y: number; text: string }

function rects(svg: string): Rect[] {
  const all = [...svg.matchAll(/<path[^>]*d="M([\d.-]+) ([\d.-]+)l([\d.-]+) 0l0 ([\d.-]+)[^"]*"[^>]*fill="([^"]+)"/g)]
    .map((m) => ({ centre: Number(m[1]) + Number(m[3]) / 2, top: Number(m[2]), width: Number(m[3]),
      bottom: Number(m[2]) + Number(m[4]), fill: m[5]! }));
  const widest = Math.max(...all.map((r) => r.width));
  return all.filter((r) => r.width < widest && r.fill.toLowerCase() !== DEFAULT_CHART_PALETTE.paper.toLowerCase());
}

function labels(svg: string): Label[] {
  return [...svg.matchAll(/<text[^>]*x="([\d.]+)"[^>]*y="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), text: m[3]! }));
}

describe("the demo's page 6 bridge", () => {
  // The v63 render's revenue of 101: the fixture's 98.8 leaves the figure
  // exactly enough room under the 200 gridline, and 101 does not. Cost of
  // sales moves by the same 2.2 so gross profit — and the walk — is unchanged.
  const v63 = {
    ...liveDemoSet,
    current: {
      ...liveDemoSet.current,
      revenue: liveDemoSet.current.revenue + 2_200,
      costOfSales: liveDemoSet.current.costOfSales + 2_200,
    },
  };
  const svg = String(buildProfitWaterfallChart(v63, PACK_SCALE).svg);

  it('sets Revenue\'s figure above its rising bar, inside the plot', () => {
    const label = labels(svg).find((l) => l.text === '101');
    expect(label, `no revenue label among ${labels(svg).map((l) => l.text).join(', ')}`).toBeDefined();
    const bar = rects(svg).find((r) => Math.abs(r.centre - label!.x) < 2)!;
    // zrender sets the type on `dominant-baseline: central`: `y` is the
    // middle of a 12px line.
    expect(label!.y + 6, `"${label!.text}" centred at ${label!.y}, bar ${bar.top}–${bar.bottom}`)
      .toBeLessThanOrEqual(bar.top);
    const top = Math.min(...yAxisTicks(svg).map((t) => t.y));
    expect(label!.y - 6, 'the figure runs off the top of the plot').toBeGreaterThanOrEqual(top);
  });
});

/**
 * THE REVIEWER'S TWO CASES, THROUGH ECHARTS ITSELF. A long category name made
 * ECharts shrink the plot under a domain chosen for the taller one, and a
 * short bar at the extreme lost its figure to the clip — which a mock of the
 * coordinate system cannot show, because it does not clip.
 */
const LONG = 'Other, not separately captured';
const HEIGHT_MM = 66.56;

function render(steps: WaterfallStep[], boxed = true): string {
  const boxPx = Math.round(HEIGHT_MM * PX_PER_MM);
  return String(renderChartSvg(
    waterfallOption(steps, PACK_SCALE, undefined, 5, false, undefined, boxed ? boxPx : undefined),
    { widthMm: 174, heightMm: HEIGHT_MM },
  ));
}

function expectOnItsSide(svg: string, step: WaterfallStep, text: string): void {
  const figure = figures(svg).find((f) => f.text === text);
  expect(figure, `"${text}" is not drawn at all`).toBeDefined();
  const clip = clipRect(svg);
  expect(outsideClip(figure!, clip), `"${text}" at ${figure!.y} leaves the plot ${clip.top}–${clip.bottom}`).toBe(false);
  const bar = barOf(svg, figure!)!;
  expect(wrongSide(figure!, bar, step.end > step.start), `"${text}" is on the wrong side of its bar`).toBe(false);
}

const RISING: WaterfallStep[] = [
  { label: 'Revenue', start: 0, end: 1_030_000, value: 1_030_000, isSubtotal: false, color: 'green' },
  { label: LONG, start: 1_030_000, end: 1_200_000, value: 170_000, isSubtotal: false, color: 'green' },
  { label: 'Operating Expenses', start: 1_200_000, end: 300_000, value: -900_000, isSubtotal: false, color: 'red' },
  { label: 'Net Profit', start: 0, end: 300_000, value: 300_000, isSubtotal: true, color: 'teal' },
];
const FALLING: WaterfallStep[] = [
  { label: 'Revenue', start: 0, end: -1_030_000, value: -1_030_000, isSubtotal: true, color: 'blue' },
  { label: LONG, start: -1_030_000, end: -1_200_000, value: -170_000, isSubtotal: false, color: 'red' },
  { label: 'Operating Expenses', start: -1_200_000, end: -300_000, value: 900_000, isSubtotal: false, color: 'green' },
  { label: 'Net Profit', start: 0, end: -300_000, value: -300_000, isSubtotal: true, color: 'teal' },
];

describe('a short bar at the edge of the domain, under a long category name', () => {
  it('prints a rising 1 030 000 → 1 200 000 bar\'s 170 inside the plot, above its base', () => {
    expectOnItsSide(render(RISING), RISING[1]!, '170');
  });

  it('prints a falling −1 030 000 → −1 200 000 bar\'s (170) inside the plot, below its head', () => {
    expectOnItsSide(render(FALLING), FALLING[1]!, '(170)');
  });

  it('draws the plot the domain was chosen for', () => {
    const svg = render(RISING);
    const layout = waterfallLayout(RISING, Math.round(HEIGHT_MM * PX_PER_MM), false, 5);
    expect(clipRect(svg).height).toBeCloseTo(layout.plotPx, 6);
  });

  it('keeps both figures on the plot with no box at all — the renderer is the last guard', () => {
    // 170 000 of 1 200 000 is a bar tall enough to carry its figure inside,
    // and that is where it goes when its own side has no room.
    for (const [steps, text] of [[RISING, '170'], [FALLING, '(170)']] as const) {
      const svg = render(steps, false);
      expectOnItsSide(svg, steps[1]!, text);
      const figure = figures(svg).find((f) => f.text === text)!;
      const bar = barOf(svg, figure)!;
      expect(figure.y - 6, `"${text}" is not inside its bar`).toBeGreaterThanOrEqual(bar.top - 0.01);
      expect(figure.y + 6, `"${text}" is not inside its bar`).toBeLessThanOrEqual(bar.bottom + 0.01);
      // In the ink that reads on the bar's fill, not the ink it would wear
      // standing on paper beside the bar.
      const fill = steps[1]!.color === 'green' ? DEFAULT_CHART_PALETTE.fav : DEFAULT_CHART_PALETTE.unfav;
      expect(figure.fill).toBe(labelInkOn(fill, DEFAULT_CHART_PALETTE).toLowerCase());
    }
  });

  it('holds a figure too big for its bar to the plot\'s edge, on its own side, with no box', () => {
    // 10 000 of 1 200 000 is a bar of a pixel or two: nothing fits inside it.
    const thin = (steps: WaterfallStep[], from: number, to: number): WaterfallStep[] => steps.map((s, i) => (i === 0
      ? { ...s, end: from, value: from }
      : i === 1 ? { ...s, start: from, end: to, value: to - from } : i === 2 ? { ...s, start: to, value: s.end - to } : s));
    const rising = thin(RISING, 1_190_000, 1_200_000);
    const falling = thin(FALLING, -1_190_000, -1_200_000);
    expectOnItsSide(render(rising, false), rising[1]!, '10');
    expectOnItsSide(render(falling, false), falling[1]!, '(10)');
  });

  it('keeps both figures on the plot in a 320px box', () => {
    // The on-screen view draws without a box — `packLegacyBridgeContainment`.
    for (const [steps, text] of [[RISING, '170'], [FALLING, '(170)']] as const) {
      const svg = String(renderChartSvg(
        waterfallOption(steps, PACK_SCALE, undefined, undefined, false, undefined, 320),
        { widthMm: 174, heightMm: 320 / PX_PER_MM },
      ));
      expectOnItsSide(svg, steps[1]!, text);
    }
  });

});

/**
 * A FIGURE HELD ONTO ITS OWN BAR IS READ AS ONE SET INSIDE IT. The edge
 * clamp can leave a figure over its own fill; its paper ground went under
 * the bar and its ink matched the fill, so a subtotal's figure vanished.
 */
describe('a figure that lands on its own bar', () => {
  const onBar = (svg: string, text: string) => {
    const figure = figures(svg).find((f) => f.text === text);
    expect(figure, `"${text}" is not drawn`).toBeDefined();
    const bar = barOf(svg, figure!)!;
    expect(overOwnBar(figure!, bar), `"${text}" is not over its bar — the case is not under test`).toBe(true);
    expect(figure!.fill, `"${text}" in ${figure!.fill} on ${bar.fill}`)
      .toBe(labelInkOn(bar.fill, DEFAULT_CHART_PALETTE).toLowerCase());
  };

  it('a short subtotal with no room on its side, drawn with no box', () => {
    const steps: WaterfallStep[] = [
      { label: 'Opening', start: 0, end: 763, value: 763, isSubtotal: true, color: 'blue' },
      { label: 'Movement 1', start: 763, end: -6141, value: -6904, isSubtotal: false, color: 'red' },
      { label: 'Movement 2', start: -6141, end: -6212, value: -71, isSubtotal: false, color: 'red' },
      { label: 'Movement 3', start: -6212, end: -6069, value: 143, isSubtotal: false, color: 'green' },
      { label: 'Closing', start: 0, end: -6069, value: -6069, isSubtotal: true, color: 'teal' },
    ];
    onBar(String(renderChartSvg(waterfallOption(steps, "R'000", undefined, 5, false), { widthMm: 174, heightMm: 60 })), '1');
  });

  it("the reviewer's red bar at nine decimal places, in a 320px box", () => {
    const v = [-3.407627811379599e-9, -3.334827873965221e-9, -3.2865170608677928e-9, -3.3274286315904543e-9];
    const steps: WaterfallStep[] = [
      { label: 'Opening', start: 0, end: v[0]!, value: v[0]!, isSubtotal: true, color: 'blue' },
      { label: 'Movement 1', start: v[0]!, end: v[1]!, value: v[1]! - v[0]!, isSubtotal: false, color: 'green' },
      { label: 'Movement 2', start: v[1]!, end: v[2]!, value: v[2]! - v[1]!, isSubtotal: false, color: 'green' },
      { label: 'Movement 3', start: v[2]!, end: v[3]!, value: v[3]! - v[2]!, isSubtotal: false, color: 'red' },
      { label: 'Closing', start: 0, end: v[3]!, value: v[3]!, isSubtotal: true, color: 'teal' },
    ];
    const svg = String(renderChartSvg(
      waterfallOption(steps, "R'000", undefined, 6, false, undefined, 320),
      { widthMm: 220, heightMm: 320 / PX_PER_MM },
    ));
    for (const figure of figures(svg)) {
      const bar = barOf(svg, figure)!;
      if (!overOwnBar(figure, bar)) continue;
      expect(figure.fill, `"${figure.text}" in ${figure.fill} on ${bar.fill}`)
        .toBe(labelInkOn(bar.fill, DEFAULT_CHART_PALETTE).toLowerCase());
    }
  });
});

