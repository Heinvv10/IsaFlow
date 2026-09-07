/**
 * SHEET 10'S CAPTION PROMISES ONE Y-SCALE. THIS IS WHAT HOLDS IT TO THAT.
 *
 * "Revenue, operating expenses, net profit and cash share one y-scale, so a
 * metric ten times the size of another cannot be mistaken for moving the same
 * amount" is printed under the panels. A shared scale is the whole point of a
 * small-multiple grid — it is what makes the panels comparable — and a caption
 * claiming one over panels that lack it is worse than no caption, because it
 * tells a director it is safe to compare.
 *
 * Nothing asserted it. `smallMultipleOption` is handed a domain, and whether
 * the four money panels are handed the SAME domain was a property of one line
 * in `buildTrendPanels` that no test read. So this reads the rendered SVG —
 * the thing a reader's eye actually measures — and fits ONE line from value
 * to pixel across all four panels. If any panel is autoscaled, its points do
 * not sit on that line.
 *
 * The two ratio panels are deliberately excluded: a percentage and a day
 * count are different units from rands and from each other, and a shared
 * scale across units is not a wider view of the same row, it is nonsense.
 * That exclusion is asserted too, so "shared" cannot quietly become "all six
 * squashed onto a rand axis".
 */
import { describe, expect, it } from 'vitest';
import { buildTrendPanels } from '@/modules/accounting/services/packs/pages/packTrendCharts';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackChartSpec } from '@/modules/accounting/services/packs/pages/packPageModel';

/**
 * Four money series a decade apart in size, which is the case the caption
 * describes: revenue in tens of thousands, cash in hundreds of thousands, and
 * a net profit that crosses zero. Every series moves, so every panel yields a
 * slope; a flat series would fit any line at all.
 */
const trend: PackTrendPoint[] = Array.from({ length: 12 }, (_, index) => ({
  month: `2026-${String(index + 1).padStart(2, '0')}`,
  label: `M${index + 1}`,
  revenue: 2_000 + index * 2_300,
  expenses: 40_000,
  netProfit: -60_000 + index * 9_000,
  costOfSales: 1_000,
  operatingExpenses: 18_000 + index * 1_700,
  grossMarginPct: 40 + index,
  cash: -115_000 - index * 48_000,
  accountsReceivable: 100_000,
  debtorDays: 30 + index,
}));

const MONEY = {
  'trend-revenue': (p: PackTrendPoint) => p.revenue,
  'trend-operating-expenses': (p: PackTrendPoint) => p.operatingExpenses,
  'trend-net-profit': (p: PackTrendPoint) => p.netProfit,
  'trend-cash': (p: PackTrendPoint) => p.cash,
} as const;

/**
 * The y of each plotted point, off the panel's own SVG.
 *
 * The series is the path with one vertex per period — the gridlines and the
 * axis are shorter, and matching on the count rather than on a class keeps
 * this working through an ECharts renderer change.
 */
function plottedYs(spec: PackChartSpec, points: number): number[] {
  const paths = [...spec.svg.matchAll(/<(?:polyline|path)[^>]*\b(?:points|d)="([^"]+)"/g)].map((m) => m[1]!);
  for (const path of paths) {
    const pairs = [...path.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((m) => Number(m[2]));
    if (pairs.length === points) return pairs;
  }
  throw new Error(`no ${points}-point series in ${spec.id}`);
}

/** The value→pixel map this panel draws, from its own endpoints. */
function scaleOf(spec: PackChartSpec, values: number[]): { slope: number; intercept: number } {
  const ys = plottedYs(spec, values.length);
  const first = 0;
  const last = values.length - 1;
  const slope = (ys[last]! - ys[first]!) / (values[last]! - values[first]!);
  return { slope, intercept: ys[first]! - slope * values[first]! };
}

describe("page 10's money panels", () => {
  const panels = buildTrendPanels(trend, "R'000");
  const byId = new Map(panels.map((panel) => [panel.id, panel]));

  it('draw every rand series through ONE value-to-pixel map', () => {
    // The map is fitted on CASH, the series with the widest span: an SVG
    // coordinate is rounded to a tenth of a pixel, and fitting a slope on
    // revenue's 2.8px of travel would measure that rounding rather than the
    // scale.
    const reference = scaleOf(byId.get('trend-cash')!, trend.map((p) => p.cash));

    for (const [id, pick] of Object.entries(MONEY)) {
      const panel = byId.get(id);
      expect(panel, `${id} is not drawn`).toBeDefined();
      const ys = plottedYs(panel!, trend.length);
      for (const [index, point] of trend.entries()) {
        const predicted = reference.intercept + reference.slope * pick(point);
        expect(
          Math.abs(ys[index]! - predicted),
          `${id} draws ${pick(point)} at ${ys[index]!.toFixed(1)}px where the shared scale puts `
            + `it at ${predicted.toFixed(1)}px — this panel is autoscaled to its own series`,
        ).toBeLessThan(1);
      }
    }

    // And the shared domain is actually WIDE — the four series span a decade,
    // so a scale fitted to any one of them would be visibly different. Without
    // this the assertion above would also pass on four identical series.
    const cashDrop = Math.abs(reference.slope * (trend[11]!.cash - trend[0]!.cash));
    const revenueRise = Math.abs(reference.slope * (trend[11]!.revenue - trend[0]!.revenue));
    expect(cashDrop).toBeGreaterThan(revenueRise * 10);
  });

  it('keeps each ratio panel on its own scale — a percentage is not a rand', () => {
    const money = scaleOf(byId.get('trend-cash')!, trend.map((p) => p.cash));
    const marginYs = plottedYs(byId.get('trend-gross-margin')!, trend.length);
    const margins = trend.map((p) => p.grossMarginPct!);

    // The panel uses its height: 40% to 51% is a line that climbs.
    expect(Math.max(...marginYs) - Math.min(...marginYs)).toBeGreaterThan(10);
    // On the rand axis the same eleven points would be one flat line half a
    // pixel thick, at the top of the panel — which is the reason a ratio does
    // not join the shared scale.
    const onMoneyAxis = Math.abs(money.slope * (Math.max(...margins) - Math.min(...margins)));
    expect(onMoneyAxis).toBeLessThan(1);
  });
});
