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
import { formatDays, formatMoney, formatPctLevel, inProse } from '@/lib/format/money';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { buildHighlightTiles } from '@/modules/accounting/services/packs/pages/packHighlights';
import { buildHighlightsBlocks } from '@/modules/accounting/services/packs/pages/packPageBlocks';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { brightsphereLiveInput, demoSet, trend } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
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
    // AND EACH OF THE TWO THAT CANNOT JOIN IT STATES ITS OWN ENDS, in its own
    // unit. It used to say only that they were "in other units, each drawn on
    // its own" — no range, neither end, nowhere on the sheet — beside lines
    // whose stated domain a reader CAN check. The values are the ones the
    // tiles were drawn on, read off the same `sparklineScale`.
    const margin = byLabel.get('Gross margin')!.sparklineScale!;
    const days = byLabel.get('Debtor days')!.sparklineScale!;
    expect(text).toContain(
      `Gross margin on ${formatPctLevel(margin.min)} to ${formatPctLevel(margin.max)}`,
    );
    expect(text).toContain(
      `Debtor days on ${formatDays(days.min)} to ${formatDays(days.max)}`,
    );
    expect(text).toContain('are in other units, each drawn on its own.');
    // The units are not interchangeable: a day count printed as a percentage
    // is a different claim about the same picture.
    expect(margin.unit).toBe('percentage');
    expect(days.unit).toBe('days');
    expect(byLabel.get('Revenue')!.sparklineScale!.unit).toBe('money');
  });

  /**
   * ONE LINE IN ANOTHER UNIT IS ONE LINE.
   *
   * The footnote's tail agrees with a count — "Gross margin and Debtor days
   * ARE in other units" — and every fixture in this suite draws both of the
   * pack's two non-money series, so the singular arm was unreachable and
   * forcing the plural was green. It is not a contrived shape: debtor days is
   * null in a month with no revenue base, and a company that bills nothing on
   * credit has no month in which it is defined, so its tile is drawn without a
   * line at all and gross margin stands alone.
   */
  it('says one measure IS in other units where only one is drawn', () => {
    const noDebtors = SPREAD.map((point) => ({ ...point, debtorDays: null }));
    const tiles = tilesFor(noDebtors);
    const byLabel = new Map(tiles.map((t) => [t.label, t]));
    // The premise: debtor days has no line to scale, gross margin does.
    expect(byLabel.get('Debtor days')!.sparklineScale).toBeNull();
    expect(byLabel.get('Gross margin')!.sparklineScale!.shared).toBe(false);

    const text = buildHighlightsBlocks(tiles, "R'000", 'ZAR', null, null)
      .footnotes.map((f) => f.text).join(' ');
    const margin = byLabel.get('Gross margin')!.sparklineScale!;
    expect(text).toContain(
      `Gross margin on ${formatPctLevel(margin.min)} to ${formatPctLevel(margin.max)} `
      + 'is in other units, each drawn on its own.',
    );
    expect(text).not.toContain('are in other units');
    expect(text).not.toContain('Debtor days');
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

/**
 * EVERY LINE PAGE 3 DRAWS HAS ITS DOMAIN ON THE SHEET.
 *
 * A blind visual gate, re-run against a clean-room copy of the render, took
 * the demo pack's sheet 3 for stating the shared money domain and nothing
 * else: gross margin and debtor days were said to be "in other units, each
 * drawn on its own" with no range, neither end, anywhere on the page. The
 * consequence is measurable off the render — the gross-margin sparkline
 * travels 65.5pt and debtor days 66.5pt beside a revenue line travelling
 * 0.8pt — so a reader could not tell whether gross margin moved five points
 * or 6 462. Page 10 prints both ends of these same two measures, so this was
 * the one place the pack's own "state the axis" discipline lapsed.
 *
 * Brightsphere never failed it: its three sparklines are all money and all
 * share the stated domain. That asymmetry is why this is asserted over BOTH
 * companies and over every drawn line rather than over the two that were
 * wrong.
 */
describe('page 3 states the domain of every line it draws', () => {
  const COMPANIES: Record<string, BoardPackInput> = {
    'the demo company': liveDemoShortPanelsInput,
    Brightsphere: brightsphereLiveInput,
  };

  const printed = (value: number, unit: 'money' | 'percentage' | 'days'): string => (
    unit === 'percentage' ? formatPctLevel(value)
      : unit === 'days' ? formatDays(value)
        : inProse(formatMoney(value, { scale: PACK_SCALE })));

  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`names both ends of every sparkline's axis on ${company}`, () => {
      const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Highlights')!;
      const said = page.footnotes.map((f) => f.text).join(' ');
      const drawn = page.blocks.flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []))
        .filter((t) => t.sparklineScale !== null);
      expect(drawn.length, `${company}: page 3 draws no sparkline, so nothing is checked`)
        .toBeGreaterThan(0);
      for (const tile of drawn) {
        const domain = tile.sparklineScale!;
        for (const end of [domain.min, domain.max]) {
          expect(
            said,
            `${company}: ${tile.label} is drawn on ${printed(domain.min, domain.unit)} to `
              + `${printed(domain.max, domain.unit)} and the sheet states no ${printed(end, domain.unit)}`,
          ).toContain(printed(end, domain.unit));
        }
      }
    });
  }

  it('is not satisfied by the money domain alone — the demo draws two lines that cannot join it', () => {
    // The premise. On a pack where every line shares one domain, the loop
    // above is satisfied by the one shared range and says nothing about the
    // rule it exists for.
    const page = buildBoardPackPages(liveDemoShortPanelsInput).pages
      .find((p) => p.navLabel === 'Highlights')!;
    const own = page.blocks.flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []))
      .filter((t) => t.sparklineScale !== null && !t.sparklineScale.shared);
    expect(own.map((t) => t.label)).toEqual(['Gross margin', 'Debtor days']);
  });
});
