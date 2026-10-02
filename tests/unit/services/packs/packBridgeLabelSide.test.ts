/**
 * A POSITIVE BAR'S FIGURE STAYS ON THE POSITIVE SIDE OF ITS BAR.
 *
 * Page 8 needed a same-ink bar too short to hold its label to set it BELOW
 * the bar: Brightsphere's opening cash of (267) runs down from zero, and its
 * figure under the bar's end is where a reader looks. The rule is shared with
 * page 6's profit bridge, where a short POSITIVE subtotal — a thin gross
 * profit over a loss-making year — then hung its figure under the zero line,
 * which reads as a negative. Read off the composed SVG.
 *
 * And a floored bar — drawn a rule's width taller than its figure — sets a
 * label below it clear of the rule, not on it.
 */
import { describe, expect, it } from 'vitest';
import { buildProfitWaterfallChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import { makeWaterfallRenderItem } from '@/modules/accounting/services/packs/packWaterfallBars';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { demoSet, figures } from './fixtures/boardPackInputs';

interface Rect { centre: number; top: number; bottom: number; fill: string }
interface Label { x: number; y: number; fill: string; text: string }

function rects(svg: string): Rect[] {
  const all = [...svg.matchAll(/<path[^>]*d="M([\d.-]+) ([\d.-]+)l([\d.-]+) 0l0 ([\d.-]+)[^"]*"[^>]*fill="([^"]+)"/g)]
    .map((m) => ({
      centre: Number(m[1]) + Number(m[3]) / 2, top: Number(m[2]), width: Number(m[3]),
      bottom: Number(m[2]) + Number(m[4]), fill: m[5]!,
    }));
  const widest = Math.max(...all.map((r) => r.width));
  return all.filter((r) => r.width < widest && r.fill.toLowerCase() !== DEFAULT_CHART_PALETTE.paper.toLowerCase());
}

function labels(svg: string): Label[] {
  return [...svg.matchAll(/<text[^>]*x="([\d.]+)"[^>]*y="([\d.-]+)"[^>]*fill="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), fill: m[3]!, text: m[4]! }));
}

/** A thin gross profit over a heavy loss: the plot runs far below zero, so
 *  there is room under the gross-profit bar for its label to fall into. */
const thinMargin: PackFigureSet = {
  ...demoSet,
  current: figures({
    revenue: 1_000_000, costOfSales: 980_000, operatingExpenses: 3_000_000,
    otherIncome: 0, otherExpenses: 0, operatingProfit: -1_980_000, netProfit: -1_980_000,
  }),
};

describe('page 6 keeps a short positive bar\'s figure above the zero line', () => {
  it('sets gross profit of 20 above its bar, not under the axis', () => {
    const svg = String(buildProfitWaterfallChart(thinMargin, PACK_SCALE).svg);
    const label = labels(svg).find((l) => l.text === '20');
    expect(label, 'the bridge prints no gross profit label').toBeDefined();
    const bar = rects(svg).find((r) => Math.abs(r.centre - label!.x) < 2);
    expect(bar, 'no bar under the label').toBeDefined();
    // The bar is positive and drawn from zero, so its bottom IS the axis.
    expect(bar!.bottom - bar!.top, 'the case under test is a SHORT bar').toBeLessThan(20);
    expect(label!.y, `the figure sits at ${label!.y}, under the zero line at ${bar!.bottom}`).toBeLessThan(bar!.top);
    // And not in the bar's own ink, which is the defect the page 8 rule fixed.
    expect(label!.fill).not.toBe(bar!.fill);
  });
});

describe('a floored bar sets a label below it clear of its rule', () => {
  it('starts the label below the drawn rule, not below the zero-height figure', () => {
    // A nil step at the top of the plot: no room above, so its label goes
    // below — and the bar is drawn one rule-width tall though its figure is 0.
    const steps: WaterfallStep[] = [
      { label: 'Open', start: 0, end: 100, value: 100, isSubtotal: true, color: 'blue' },
      { label: 'Nil', start: 100, end: 100, value: 0, isSubtotal: false, color: 'green' },
      { label: 'Close', start: 0, end: 100, value: 100, isSubtotal: true, color: 'teal' },
    ];
    const render = makeWaterfallRenderItem(steps, DEFAULT_CHART_PALETTE, PACK_SCALE, { min: 0, max: 100 }, undefined);
    // 100 px of plot from y=10 (value 100) to y=110 (value 0).
    const api = {
      coord: ([i, v]: number[]) => [40 + i! * 60, 110 - v!],
      size: () => [60, 0],
    };
    const group = render({ dataIndex: 1 } as never, api as never) as unknown as {
      children: Array<{ type: string; name?: string; shape?: { y: number; height: number }; style: { y?: number } }>;
    };
    const bar = group.children.find((c) => c.name === 'bar')!;
    const text = group.children.find((c) => c.type === 'text')!;
    expect(bar.shape!.height).toBeGreaterThan(0);
    // The same four-pixel gap every other label keeps from its bar's end:
    // measured from the RULE, which is what the reader sees as the bar.
    expect(text.style.y!).toBeGreaterThanOrEqual(bar.shape!.y + bar.shape!.height + 4);
  });
});
