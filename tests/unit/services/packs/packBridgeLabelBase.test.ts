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
import { makeWaterfallRenderItem } from '@/modules/accounting/services/packs/packWaterfallBars';
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

/** One bar through the renderer, on a plot of 100px from y=10 (`max`) down. */
function place(step: WaterfallStep, domain: { min: number; max: number }) {
  const render = makeWaterfallRenderItem([step], DEFAULT_CHART_PALETTE, PACK_SCALE, domain, undefined);
  const px = (v: number) => 10 + ((domain.max - v) / (domain.max - domain.min)) * 100;
  const api = { coord: ([, v]: number[]) => [40, px(v!)], size: () => [60, 0] };
  const group = render({ dataIndex: 0 } as never, api as never) as unknown as {
    children: Array<{ type: string; name?: string; shape?: { y: number; height: number }; style: { y?: number; verticalAlign?: string } }>;
  };
  const bar = group.children.find((c) => c.name === 'bar')!;
  const text = group.children.find((c) => c.type === 'text')!;
  return { top: bar.shape!.y, bottom: bar.shape!.y + bar.shape!.height, y: text.style.y!, align: text.style.verticalAlign! };
}

describe('the two mirror cases, with no room on the correct side', () => {
  it('keeps a short rising bar\'s figure above it when the plot ends at its top', () => {
    // 10px of bar with 2px of plot above it: no room, and too short to hold it.
    const at = place({ label: 'Up', start: 0, end: 10, value: 10, isSubtotal: false, color: 'green' }, { min: -88, max: 12 });
    // Bottom-anchored above the bar, never top-anchored under it.
    expect(at.align).toBe('bottom');
    expect(at.y).toBeLessThanOrEqual(at.top);
  });

  it('keeps a short falling same-ink bar\'s figure below it when the plot ends at its foot', () => {
    const at = place({ label: 'Down', start: 0, end: -10, value: -10, isSubtotal: true, color: 'teal' }, { min: -12, max: 88 });
    expect(at.align).toBe('top');
    expect(at.y).toBeGreaterThanOrEqual(at.bottom);
  });
});
