/**
 * THE MANAGEMENT PACK'S TWELVE-MONTH TREND SAYS WHAT IT DRAWS.
 *
 * Printed, it was nine empty months and three unlabelled bars under a
 * heading: no series name, no figure on any bar, nothing marking September
 * as seven days, and on Brightsphere a single bar with no value at all. The
 * chart now names its series, labels its bars (every one where there are
 * few, the last where there are many), marks the part month as the board
 * pack's trend does, and starts at the first month revenue is posted — the
 * caption says where it starts and why.
 */
import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/format/money';
import { legacyTrendCaption, legacyTrendOption } from '@/components/accounting/packs/PackSectionView';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { liveDemoTrend } from './fixtures/liveDemoBoardPack';
import { outsideSvg } from './support/svgBounds';
import { renderLegacyOption } from './support/legacyBridge';
import { glyphCells } from './support/bridgeSvg';

const unesc = (s: string) => s.replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const texts = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => unesc(m[1]!).replace(/ /g, ' '));
const withRevenue = (revenue: number[]): PackTrendPoint[] => liveDemoTrend.map((p, i) => ({ ...p, revenue: revenue[i]! }));
const R = (n: number) => formatMoney(n, { scale: 'R' }).replace(/ /g, ' ');

/** The Demo company: nothing posted until July, September a part month. */
const DEMO = withRevenue([0, 0, 0, 0, 0, 0, 0, 0, 0, 36_800, 35_150, 29_730]);
/** A company trading all year. */
const YEAR = withRevenue([41_000, 39_500, 44_100, 38_000, 40_200, 42_900, 43_300, 39_800, 41_700, 45_000, 44_400, 12_100]);

describe('the management pack\'s twelve-month trend', () => {
  it('starts at the first month with revenue, says so, and labels every one of a few bars', () => {
    const svg = renderLegacyOption(legacyTrendOption(DEMO), 718, 320);
    const printed = texts(svg);
    expect(printed).not.toContain('Oct 2025');
    expect(printed).toContain('Jul 2026');
    expect(printed).toContain('Sep 2026 (part)');
    expect(printed).toContain('Revenue');
    for (const v of [36_800, 35_150, 29_730]) expect(printed).toContain(R(v));
    expect(legacyTrendCaption(DEMO)).toBe(
      'Revenue by month, Jul 2026 to Sep 2026; none is posted before Jul 2026. '
      + 'Sep 2026 is a part month: it covers 7 of its 30 days, so its figure is not comparable with the months before it.',
    );
    expect(outsideSvg(svg)).toEqual([]);
  });

  it('labels the last of many bars, and marks the part month', () => {
    const svg = renderLegacyOption(legacyTrendOption(YEAR), 718, 320);
    const printed = texts(svg);
    expect(printed).toContain('Oct 2025');
    expect(printed).toContain('Sep 2026 (part)');
    expect(printed).toContain(R(12_100));
    expect(printed).not.toContain(R(41_000));
    expect(legacyTrendCaption(YEAR)).toBe(
      'Revenue by month, Oct 2025 to Sep 2026. '
      + 'Sep 2026 is a part month: it covers 7 of its 30 days, so its figure is not comparable with the months before it.',
    );
    expect(outsideSvg(svg)).toEqual([]);
  });

  it('labels a single bar', () => {
    const one = withRevenue([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 29_731]);
    expect(texts(renderLegacyOption(legacyTrendOption(one), 718, 320))).toContain(R(29_731));
  });

  it('says there is none where nothing is posted in the twelve months', () => {
    const none = withRevenue(Array(12).fill(0));
    expect(legacyTrendCaption(none)).toBe('No revenue is posted in the twelve months to Sep 2026.');
  });
});

/** Every upright text — figures, legend, ticks, axis name — as a glyph box. */
function uprightBoxes(svg: string) {
  return [...svg.matchAll(/<text([^>]*)>([^<]+)<\/text>/g)].flatMap((m) => {
    const at = m[1]!.match(/transform="translate\(([-\d.]+) ([-\d.]+)\)"/);
    if (at === null) return [];
    const px = Number(m[1]!.match(/font-size:([\d.]+)px/)?.[1] ?? 12);
    const x = Number(at[1]) + Number(m[1]!.match(/ x="([-\d.]+)"/)?.[1] ?? 0);
    const y = Number(at[2]) + Number(m[1]!.match(/ y="([-\d.]+)"/)?.[1] ?? 0);
    const text = unesc(m[2]!);
    const cells = glyphCells(text, 0, px);
    const width = cells[cells.length - 1]!.right - cells[0]!.left;
    const anchor = m[1]!.match(/text-anchor="(\w+)"/)?.[1];
    const left = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x;
    return [{ text, left, right: left + width, top: y - px / 2, bottom: y + px / 2 }];
  });
}

/** Seeded trends: a late first month, magnitudes from hundreds to a billion,
 *  now and then a month of net credit notes. */
function* trends(seedValue: number, n: number): Generator<PackTrendPoint[]> {
  let seed = seedValue;
  const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  for (let i = 0; i < n; i += 1) {
    const late = Math.floor(rnd() * 12);
    const scale = Math.pow(10, 2 + rnd() * 7);
    yield withRevenue(Array.from({ length: 12 }, (_, m) => (m < late ? 0 : Math.round(scale * (rnd() < 0.05 ? -0.3 : 0.2 + rnd())))));
  }
}

describe('the management pack\'s trend, fuzzed in its print box', () => {
  it.each([424_242, 777_001, 13_579, 20_260_930, 5_550_123, 31_415_927])('every figure printed, inside the chart, on nothing else — seed %i', (seed) => {
    for (const points of trends(seed, 40)) {
      const svg = renderLegacyOption(legacyTrendOption(points), 718, 320);
      const drawn = points.slice(points.findIndex((p) => p.revenue !== 0));
      const due = drawn.length <= 6 ? drawn : drawn.slice(-1);
      const printed = texts(svg);
      const boxes = uprightBoxes(svg);
      const faults = [
        ...due.filter((p) => !printed.includes(R(p.revenue))).map((p) => `${p.label}'s ${R(p.revenue)} is not printed`),
        ...outsideSvg(svg),
        ...boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => Math.max(a.left - b.right, b.left - a.right, a.top - b.bottom, b.top - a.bottom) < 1)
          .map((b) => `"${a.text}" meets "${b.text}"`)),
      ];
      expect(faults, points.map((p) => p.revenue).join(', ')).toEqual([]);
    }
  });
});

