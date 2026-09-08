/**
 * A SUM BAR SITS ON THE BASELINE, AND A READER HAS TO BE ABLE TO SEE THAT.
 *
 * A blind gate measured the demo pack's Gross Profit bar as running from +96
 * to (1 325) against a table reading (1 329), called it 7.6% overstated, and
 * failed the sheet. The BAR is based at zero — rect top 61.0 with zero at
 * 61.0, measured off the composed SVG. What it measured was the bar plus the
 * label above it: 16 page pixels of dark, which at 6.02 units per pixel is
 * the +96 it reported, and which is exactly one 12px line of type and its 4px
 * gap. A subtotal is filled with `palette.ink` and its label above it was set
 * in `palette.ink`, so the two were one mark.
 *
 * IT HID ON BRIGHTSPHERE, whose totals reach the top of the plot: those
 * labels went INSIDE in paper, so no dark type sat above a dark bar and the
 * same scan read the same geometry as correct. Right on one sheet and
 * ambiguous on the other, off a rule that never asked what the bar was
 * filled with.
 *
 * Two properties, and both are read off the painted SVG rather than off the
 * model that produced it:
 *
 *  1. every subtotal's rect spans zero to its own figure; and
 *  2. no label is set in the ink of the bar it sits above.
 */
import { describe, expect, it } from 'vitest';
import { buildCashWaterfallChart, buildProfitWaterfallChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackChartSpec } from '@/modules/accounting/services/packs/pages/packChartModel';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { brightsphereLiveSet } from './fixtures/boardPackInputs';
import { liveDemoSet } from './fixtures/liveDemoBoardPack';

interface Rect { centre: number; top: number; bottom: number; fill: string }
interface Label { x: number; y: number; fill: string; text: string }

/** Every bar the renderer painted, in the order it painted them — which is
 *  the order of `waterfallBars`. The clip rect is the widest and is dropped. */
function rects(svg: string): Rect[] {
  const all = [...svg.matchAll(/<path[^>]*d="M([\d.-]+) ([\d.-]+)l([\d.-]+) 0l0 ([\d.-]+)[^"]*"[^>]*fill="([^"]+)"/g)]
    .map((m) => ({
      centre: Number(m[1]) + Number(m[3]) / 2,
      top: Number(m[2]),
      width: Number(m[3]),
      bottom: Number(m[2]) + Number(m[4]),
      fill: m[5]!,
    }));
  const widest = Math.max(...all.map((r) => r.width));
  return all.filter((r) => r.width < widest).map(({ centre, top, bottom, fill }) => ({ centre, top, bottom, fill }));
}

function labels(svg: string): Label[] {
  return [...svg.matchAll(/<text[^>]*x="([\d.]+)"[^>]*y="([\d.-]+)"[^>]*fill="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), fill: m[3]!, text: m[4]! }));
}

/** The cash bridge, or null on a company the pack refuses to draw one for —
 *  the demo's page 8 is exactly that, and says so in prose. */
function cashBridge(set: PackFigureSet): PackChartSpec | null {
  const built = buildCashWaterfallChart(set, PACK_SCALE);
  return built.drawn ? built.chart : null;
}

const CHARTS: Array<[string, () => PackChartSpec | null]> = [
  ['the demo bridge', () => buildProfitWaterfallChart(liveDemoSet, PACK_SCALE)],
  ['the Brightsphere bridge', () => buildProfitWaterfallChart(brightsphereLiveSet, PACK_SCALE)],
  ['the demo cash bridge', () => cashBridge(liveDemoSet)],
  ['the Brightsphere cash bridge', () => cashBridge(brightsphereLiveSet)],
];

describe('a bridge subtotal is drawn from the baseline', () => {
  for (const [name, build] of CHARTS) {
    it(`bases every sum bar at zero on ${name}`, () => {
      const chart = build();
      if (chart === null) return; // this company draws no such bridge
      const bars = chart.waterfallBars ?? [];
      const drawn = rects(String(chart.svg));
      expect(drawn.length, 'no bars painted, so nothing is measured').toBe(bars.length);
      const subtotals = bars.map((b, i) => ({ bar: b, rect: drawn[i]! })).filter((p) => p.bar.kind === 'subtotal' || p.bar.kind === 'open' || p.bar.kind === 'close');
      expect(subtotals.length, `${name} paints no subtotal`).toBeGreaterThan(0);

      // THE PIXEL ZERO, SOLVED FROM THE DRAWING. The tallest bar gives the
      // value-to-pixel transform — its top is its larger endpoint and its
      // bottom the smaller — and zero is wherever that transform puts it. Read
      // off the painting rather than assumed from `grid.top`, which is what
      // this test exists to check in the first place.
      const scaleBar = bars.map((b, i) => ({ bar: b, rect: drawn[i]! }))
        .filter((p) => p.bar.start !== p.bar.end)
        .sort((a, b) => (b.rect.bottom - b.rect.top) - (a.rect.bottom - a.rect.top))[0];
      expect(scaleBar, 'every bar is nil, so there is no scale to solve').toBeDefined();
      const hi = Math.max(scaleBar!.bar.start, scaleBar!.bar.end);
      const lo = Math.min(scaleBar!.bar.start, scaleBar!.bar.end);
      const pxPerUnit = (scaleBar!.rect.bottom - scaleBar!.rect.top) / (hi - lo);
      const zeroPx = scaleBar!.rect.top + (hi - 0) * pxPerUnit;

      for (const { bar, rect } of subtotals) {
        const base = bar.end >= 0 ? rect.bottom : rect.top;
        expect(
          Math.abs(base - zeroPx),
          `${bar.label} is based at ${base} and zero is at ${zeroPx}: a sum bar that does not `
            + 'sit on the baseline paints more ink than its own figure',
        ).toBeLessThanOrEqual(1);
      }
    });

    it(`never sets a label in the ink of the bar it sits above on ${name}`, () => {
      const chart = build();
      if (chart === null) return;
      const svg = String(chart.svg);
      const drawn = rects(svg);
      // NOT VACUOUS: this chart paints labels, and some of them sit above
      // their bar rather than inside it.
      const above = labels(svg)
        .map((label) => ({ label, bar: drawn.find((r) => Math.abs(r.centre - label.x) < 2 && label.y < r.top) }))
        .filter((p): p is { label: Label; bar: Rect } => p.bar !== undefined);
      expect(labels(svg).length, `${name} paints no bar labels`).toBeGreaterThan(0);
      for (const { label, bar } of above) {
        expect(
          label.fill,
          `"${label.text}" is set in ${label.fill} ${(bar.top - label.y).toFixed(0)}px above a bar of the `
            + 'same ink — the two read as one mark, which is how a sum bar came to be measured as '
            + '7.6% taller than its own figure',
        ).not.toBe(bar.fill);
      }
    });
  }
});
