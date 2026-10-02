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
    const svg = renderLegacyOption(legacyTrendOption(DEMO), 657, 320);
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
    const svg = renderLegacyOption(legacyTrendOption(YEAR), 657, 320);
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
    expect(texts(renderLegacyOption(legacyTrendOption(one), 657, 320))).toContain(R(29_731));
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
    const text = unesc(m[2]!).replace(/ /g, ' ');
    const cells = glyphCells(text, 0, px);
    const width = cells[cells.length - 1]!.right - cells[0]!.left;
    const anchor = m[1]!.match(/text-anchor="(\w+)"/)?.[1];
    const left = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x;
    return [{ text, anchor, left, right: left + width, top: y - px / 2, bottom: y + px / 2 }];
  });
}

/** What is wrong with a drawn trend, as sentences: a figure due and not
 *  printed, printed on the wrong side of the zero line or below the plot
 *  (into the month names), or meeting another text. */
function trendFaults(svg: string, points: PackTrendPoint[]): string[] {
  const drawn = points.slice(Math.max(0, points.findIndex((p) => p.revenue !== 0)));
  const due = drawn.length <= 6 ? drawn : drawn.slice(-1);
  const boxes = uprightBoxes(svg);
  const ticks = boxes.filter((b) => b.anchor === 'end');
  const zeroY = ticks.find((t) => t.text === '–');
  const plotBottom = Math.max(...ticks.map((t) => (t.top + t.bottom) / 2));
  const faults: string[] = [];
  for (const p of due.filter((d) => d.revenue !== 0)) {
    const label = boxes.find((b) => b.anchor === 'middle' && b.text === R(p.revenue));
    if (label === undefined) { faults.push(`${p.label}'s ${R(p.revenue)} is not printed`); continue; }
    if (zeroY !== undefined) {
      const zero = (zeroY.top + zeroY.bottom) / 2;
      if (p.revenue < 0 && label.top < zero - 0.5) faults.push(`${p.label}'s ${label.text} sits above the zero line`);
      if (p.revenue > 0 && label.bottom > zero + 0.5) faults.push(`${p.label}'s ${label.text} sits below the zero line`);
    }
    if (label.bottom > plotBottom + 0.5) faults.push(`${p.label}'s ${label.text} runs below the plot into the month names`);
  }
  return [
    ...faults,
    ...outsideSvg(svg),
    ...boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => Math.max(a.left - b.right, b.left - a.right, a.top - b.bottom, b.top - a.bottom) < 1)
      .map((b) => `"${a.text}" meets "${b.text}"`)),
  ];
}

/** Seeded trends: a late first month, magnitudes from hundreds to a billion,
 *  and months of net credit notes — now and then one large enough to be the
 *  chart's lowest bar. */
function* trends(seedValue: number, n: number): Generator<PackTrendPoint[]> {
  let seed = seedValue;
  const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  for (let i = 0; i < n; i += 1) {
    const late = Math.floor(rnd() * 12);
    const scale = Math.pow(10, 2 + rnd() * 7);
    const credits = rnd() < 0.3 ? 0.25 : 0.05;
    yield withRevenue(Array.from({ length: 12 }, (_, m) => (m < late ? 0 : Math.round(scale * (rnd() < credits ? -(0.1 + 2 * rnd()) : 0.2 + rnd())))));
  }
}

/** The print box — 174mm of portrait measure, 657px — and the 190mm it was. */
const WIDTHS = [657, 718];

describe('the management pack\'s trend, fuzzed in its print box', () => {
  it('puts a negative month\'s figure below its bar, and inside the plot', () => {
    // Brightsphere's six months: one net credit of 5 535 000.
    const points = withRevenue([0, 0, 0, 0, 0, 0, 1_204_500, 980_250, -5_535_000, 1_310_400, 1_102_900, 640_300]);
    for (const width of WIDTHS) expect(trendFaults(renderLegacyOption(legacyTrendOption(points), width, 320), points)).toEqual([]);
  });

  it.each([424_242, 777_001, 13_579, 20_260_930, 5_550_123, 31_415_927, 60_917_011])('every figure printed, on its own side of zero, inside the chart, on nothing else — seed %i', (seed) => {
    for (const points of trends(seed, 40)) {
      for (const width of WIDTHS) {
        const svg = renderLegacyOption(legacyTrendOption(points), width, 320);
        expect(trendFaults(svg, points), `${width}px: ${points.map((p) => p.revenue).join(', ')}`).toEqual([]);
      }
    }
  });
});
