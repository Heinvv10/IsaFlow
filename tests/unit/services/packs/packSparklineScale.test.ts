/**
 * A RAND MOVEMENT IS DRAWN THE SAME HEIGHT AS AN EQUAL RAND MOVEMENT BESIDE IT.
 *
 * Page 3's sparklines were each normalised to their own tile, so every line
 * filled its box whatever it plotted. Measured off the v51 renders at 300 dpi,
 * on identical tile widths:
 *
 *   demo  Revenue     series swing     37   drawn 313 px
 *   demo  Net profit  series swing  2 692   drawn 303 px
 *   BS    Revenue     series swing (5 535)  drawn 342 px
 *   BS    Net profit  series swing (1 408)  drawn 348 px
 *
 * A R37k move and a R2.69m move the same height, in the same units, in one row
 * of tiles four centimetres apart — and on Brightsphere the SMALLER swing drawn
 * the DEEPER. The pack forbids exactly this one sheet later: page 10's "Net
 * profit and Cash share one y-scale, so neither of them can look like it moved
 * more than it did".
 *
 * MEASURED OFF THE DRAWN LINE, NOT OFF THE OPTION. The option is where the
 * domain is set and the SVG is what a reader receives; asserting on `yAxis.min`
 * would go green on a domain ECharts then ignored. The vertices come out of the
 * rendered path, which is the same thing `packTrendSharedScale.test.ts` does
 * for page 10's panels.
 */
import { describe, expect, it } from 'vitest';
import { buildHighlightTiles } from '@/modules/accounting/services/packs/pages/packHighlights';
import { buildHighlightsBlocks } from '@/modules/accounting/services/packs/pages/packPageBlocks';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { demoSet, trend } from './fixtures/boardPackInputs';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackKpiTile } from '@/modules/accounting/services/packs/pages/packPageModel';

/**
 * A series whose three money measures move by wildly different amounts — the
 * shape of the defect. Revenue barely moves, net profit swings by two orders of
 * magnitude more, and cash runs below zero throughout, so the domain has to
 * contain zero as well.
 */
const SPREAD: PackTrendPoint[] = trend.map((point, i) => ({
  ...point,
  revenue: 600_000 + i * 3_000,
  netProfit: -900_000 + i * 300_000,
  cash: -1_600_000 + i * 120_000,
}));

/** The y-coordinates the rendered line actually visits. */
function drawnYs(svg: string): number[] {
  // The series is the only `<path>` carrying a stroke of the ink colour; its
  // `d` is a move-to followed by line-tos, all absolute.
  const paths = [...svg.matchAll(/<path[^>]*\bd="([^"]*)"/g)].map((m) => m[1]!);
  const line = paths
    .map((d) => [...d.matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)].map((m) => Number(m[2])))
    .sort((a, b) => b.length - a.length)[0] ?? [];
  return line;
}

/** How many pixels of ink the line covers vertically. */
function drawnHeightPx(tile: PackKpiTile): number {
  const ys = drawnYs(tile.sparklineSvg!);
  expect(ys.length, `${tile.label}: no drawn line found`).toBeGreaterThan(1);
  return Math.max(...ys) - Math.min(...ys);
}

const swingOf = (series: (p: PackTrendPoint) => number): number => {
  const values = SPREAD.map(series);
  return Math.max(...values) - Math.min(...values);
};

function tilesFor(points: PackTrendPoint[]): PackKpiTile[] {
  return buildHighlightTiles(demoSet, points, new PackFigureProvenance());
}

describe('the highlights sparklines', () => {
  it('draws every money line to ONE scale, so the smaller move is the shorter line', () => {
    const tiles = tilesFor(SPREAD);
    const byLabel = new Map(tiles.map((t) => [t.label, t]));
    const money = ['Revenue', 'Net profit', 'Cash'].map((label) => byLabel.get(label)!);

    // The fixture must contain the case. Without this the equality below is
    // satisfied by three series that happen to move by the same amount, which
    // is exactly the document every previous gate read.
    const swings = [swingOf((p) => p.revenue), swingOf((p) => p.netProfit), swingOf((p) => p.cash)];
    expect(Math.max(...swings) / Math.min(...swings)).toBeGreaterThan(50);

    // One value-to-pixel map for all three, taken off the LARGEST series and
    // then held against the others. A tolerance in PIXELS rather than a
    // percentage, because the smallest line here is a millimetre and a half
    // tall: a 2% tolerance on 1.5 px is 0.03 px, which is below the precision
    // the renderer writes its coordinates at, while a whole pixel off the
    // 87 px line would be a different scale by any reading.
    const pxPerRand = drawnHeightPx(money[1]!) / swings[1]!;
    for (const [i, tile] of money.entries()) {
      const expected = swings[i]! * pxPerRand;
      expect(
        Math.abs(drawnHeightPx(tile) - expected),
        `${tile.label}: drawn ${drawnHeightPx(tile)} px, one scale says ${expected} px`,
      ).toBeLessThan(1);
    }

    // And the consequence a director sees, stated on its own: the small mover
    // is drawn short. This is the assertion the old drawing failed by 10 px in
    // the WRONG direction.
    expect(drawnHeightPx(byLabel.get('Revenue')!))
      .toBeLessThan(drawnHeightPx(byLabel.get('Net profit')!) / 10);
  });

  it('gives a series in another unit its own scale, and says so on the sheet', () => {
    const tiles = tilesFor(SPREAD);
    const byLabel = new Map(tiles.map((t) => [t.label, t]));

    for (const label of ['Revenue', 'Net profit', 'Cash']) {
      expect(byLabel.get(label)!.sparklineScale!.shared, label).toBe(true);
    }
    // A percentage and a day count cannot sit on a rand domain.
    for (const label of ['Gross margin', 'Debtor days']) {
      expect(byLabel.get(label)!.sparklineScale!.shared, label).toBe(false);
    }

    const { footnotes } = buildHighlightsBlocks(tiles, "R'000", 'ZAR', null, null);
    const text = footnotes.map((f) => f.text).join(' ');
    // The DOMAIN, in the figures the sheet prints elsewhere: the shared min is
    // cash's floor of (1 600) and the max is net profit's 2 700.
    expect(text).toContain('(1\u00a0600) to 2\u00a0700');
    expect(text).toContain('Revenue, Net profit and Cash share one y-scale');
    expect(text).toContain('Gross margin and Debtor days are in other units');
  });

  it('states a domain the lines were actually drawn on', () => {
    const tiles = tilesFor(SPREAD);
    const money = tiles.filter((t) => t.sparklineScale?.shared === true);

    // Every money tile claims the SAME domain — one scale is one pair of
    // numbers, and a footnote that quotes the first tile's would be a true
    // sentence about a picture that was not drawn.
    const domains = new Set(money.map((t) => `${t.sparklineScale!.min}/${t.sparklineScale!.max}`));
    expect(domains.size).toBe(1);

    // And it is the domain the SERIES need: the widest money series' extremes,
    // with zero inside.
    const values = SPREAD.flatMap((p) => [p.revenue, p.netProfit, p.cash]);
    expect(money[0]!.sparklineScale!.min).toBe(Math.min(0, ...values));
    expect(money[0]!.sparklineScale!.max).toBe(Math.max(0, ...values));
  });
});
