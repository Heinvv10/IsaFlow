/**
 * THE MANAGEMENT PACK'S BRIDGE, ON THE EXACT-PLOT LAYOUT, IN THE PRINT FACE.
 *
 * The view's chart theme sets text in IBM Plex Mono, a face the print page
 * does not load: every axis label fell back to DejaVu Sans Mono in the
 * Gotenberg image — a second typeface embedded in the PDF — and the layout
 * was measuring a 0.6em advance for a face that was not there. The view's
 * options now state the pack's own print face, IBM Plex Sans, over the
 * theme's, and the layout measures that face's advances. This renders with
 * the theme registered, as `EChart` does: every text is in the print face,
 * every axis label lies inside the SVG, every figure on the plot and
 * legible, and no two ticks stand closer than 18px.
 *
 * Tick widths are the face's own advances (`glyphCells`); category names are
 * measured by zrender's table, which is not the ruler production uses and
 * reads this face to within three pixels — the tolerance below.
 */
import { describe, expect, it } from 'vitest';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { format } from 'echarts/core';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';
import { legacyTrendOption } from '@/components/accounting/packs/PackSectionView';
import { clipRect, figures, glyphCells, illegible, outsideClip } from './support/bridgeSvg';
import { DEMO_MANAGEMENT_BRIDGE, fontFamilies, renderLegacyBridge as render, renderLegacyOption } from './support/legacyBridge';

const PX = 12;
/** How far zrender's table reads a category name from the face's own width. */
const NAME_RULER_PX = 3;
const tickWidth = (text: string): number => { const cells = glyphCells(text, 0); return cells[cells.length - 1]!.right - cells[0]!.left; };
const nameWidth = (text: string): number => format.getTextRect(text, `${PX}px ${PACK_FONT_STACK}`).width;

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'");

/** Every way the drawn chart breaks the containment rules, as sentences. */
function breaches(svg: string, steps: WaterfallStep[], height: number): string[] {
  const out: string[] = [];
  const ticks = [...svg.matchAll(/text-anchor="end"[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\)"[^>]*>([^<]*)<\/text>/g)];
  // NOT VACUOUS: an axis that printed nothing, or names this did not find,
  // would pass every check below by having nothing to check.
  if (ticks.length < 2) out.push(`only ${ticks.length} value ticks were read`);
  for (const m of ticks) {
    const left = Number(m[1]) - tickWidth(unesc(m[3]!));
    if (left < -0.5) out.push(`tick "${m[3]}" starts at ${left.toFixed(1)}`);
  }
  const names = [...svg.matchAll(/transform="matrix\(0.866,-0.5,0.5,0.866,([-\d.]+),([-\d.]+)\)"[^>]*>([^<]*)<\/text>/g)];
  if (names.length !== steps.length) out.push(`${names.length} category names were read for ${steps.length} bars`);
  for (const m of names) {
    const w = nameWidth(unesc(m[3]!));
    const bottom = Number(m[2]) + 0.5 * w + 0.65 * PX * 0.866;
    const left = Number(m[1]) - 0.866 * w - 0.5 * PX * 0.5;
    if (bottom > height + NAME_RULER_PX / 2 || left < -NAME_RULER_PX) out.push(`name "${m[3]}" reaches ${bottom.toFixed(1)}/${height}, left ${left.toFixed(1)}`);
  }
  const clip = clipRect(svg);
  const drawn = figures(svg);
  if (drawn.length !== steps.length) out.push(`${drawn.length} figures were read for ${steps.length} bars`);
  for (const figure of drawn) if (outsideClip(figure, clip)) out.push(`"${figure.text}" leaves the plot`);
  out.push(...illegible(svg));
  const ys = ticks.map((m) => Number(m[2])).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i += 1) if (ys[i]! - ys[i - 1]! < 18 - 0.01) { out.push(`ticks ${(ys[i]! - ys[i - 1]!).toFixed(1)}px apart`); break; }
  return out;
}

const bridge = (rev: number, net: number): WaterfallStep[] => [
  { label: 'Revenue', start: 0, end: rev, value: rev, isSubtotal: false, color: 'green' },
  { label: 'Cost of Sales', start: rev, end: rev * 0.6, value: -rev * 0.4, isSubtotal: false, color: 'red' },
  { label: 'Gross Profit', start: 0, end: rev * 0.6, value: rev * 0.6, isSubtotal: true, color: 'teal' },
  { label: 'Operating Expenses', start: rev * 0.6, end: net, value: net - rev * 0.6, isSubtotal: false, color: 'red' },
  { label: 'Net Profit', start: 0, end: net, value: net, isSubtotal: true, color: net >= 0 ? 'teal' : 'red' },
];

/** The reviewer's bridge generator (fuzz8.ts), by seed. */
function* bridges(seedValue: number, n: number): Generator<WaterfallStep[]> {
  let seed = seedValue;
  const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  const longs = ['Other, not separately captured', 'Unexplained movement', 'Operating Expenses', 'Closing Balance'];
  for (let i = 0; i < n; i += 1) {
    // Whole rands to a trillion: below a rand ECharts refuses the domain
    // outright, a renderer error the reviewer's harness counts apart.
    const mag = Math.pow(10, Math.floor(rnd() * 13));
    const v = () => (rnd() - 0.5) * 2 * mag;
    const r2 = (x: number) => (mag >= 1 ? Math.round(x) : x);
    const open = r2(v() * (rnd() < 0.2 ? 0 : 1));
    const steps: WaterfallStep[] = [{ label: 'Opening', start: 0, end: open, value: open, isSubtotal: true, color: 'blue' }];
    let running = open;
    const count = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < count; k += 1) {
      const move = r2(v() * (rnd() < 0.4 ? 0.02 : 1));
      const label = rnd() < 0.25 ? longs[Math.floor(rnd() * longs.length)]! : `Movement ${k + 1}`;
      steps.push({ label, start: running, end: running + move, value: move, isSubtotal: false, color: move >= 0 ? 'green' : 'red' });
      running += move;
    }
    steps.push({ label: 'Closing', start: 0, end: running, value: running, isSubtotal: true, color: 'teal' });
    yield steps;
  }
}

describe('the legacy bridge, in the print face', () => {
  for (const [rev, net] of [[2_500_000, 300_000], [12_000_000, -3_000_000], [25_000_000, 2_000_000], [140_000_000, -30_000_000]]) {
    it(`keeps every axis label inside the chart at revenue ${rev}`, () => {
      const steps = bridge(rev, net);
      expect(breaches(render(steps, 900, 320), steps, 320)).toEqual([]);
    });
  }

  it('holds on 1 000 seeded bridges at 240, 320 and 420px, three widths', () => {
    const failures: string[] = [];
    let k = 0;
    for (const steps of bridges(424_242, 1_000)) {
      const height = [240, 320, 420][k % 3]!;
      const width = [480, 700, 900][Math.floor(k / 3) % 3]!;
      const svg = render(steps, width, height);
      for (const b of breaches(svg, steps, height)) failures.push(`#${k} ${width}x${height}: ${b}`);
      k += 1;
    }
    expect(failures.slice(0, 6), `${failures.length} breaches`).toEqual([]);
  }, 180_000);
});

describe('the management pack\'s charts are set in the pack\'s print face', () => {
  const PRINT_FACE = PACK_FONT_STACK;

  it('the bridge: every text, over a theme that asks for IBM Plex Mono', () => {
    const svg = render(DEMO_MANAGEMENT_BRIDGE, 718, 320);
    expect((svg.match(/<text\b/g) ?? []).length, 'no text was drawn, so no face is under test').toBeGreaterThan(15);
    expect(fontFamilies(svg)).toEqual([PRINT_FACE]);
  });

  it('the twelve-month trend: every text', () => {
    const points = Array.from({ length: 12 }, (_, i) => ({ label: `M${i + 1} 2026`, revenue: 100_000 + i * 12_500 }));
    const svg = renderLegacyOption(legacyTrendOption(points), 718, 320);
    expect((svg.match(/<text\b/g) ?? []).length, 'no text was drawn, so no face is under test').toBeGreaterThan(12);
    expect(fontFamilies(svg)).toEqual([PRINT_FACE]);
  });

  it.each([
    ['a year of nil revenue', Array(12).fill(0)],
    ['revenue under a rand a month', [0.4, 0.9, 0.2, 0.6, 0.8, 0.1, 0.3, 0.7, 0.5, 0.9, 0.2, 0.6]],
    ['revenue of a few rand', [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8]],
  ])('the twelve-month trend prints no figure on two ticks: %s', (_name, revenue) => {
    const points = revenue.map((r, i) => ({ label: `M${i + 1} 2026`, revenue: r }));
    const svg = renderLegacyOption(legacyTrendOption(points), 718, 320);
    const ticks = [...svg.matchAll(/text-anchor="end"[^>]*transform="translate\([^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
    expect(ticks.length, 'no value ticks were read').toBeGreaterThan(0);
    expect(ticks, ticks.join(' | ')).toEqual([...new Set(ticks)]);
  });
  // At most about thirty cents even one step asked for rounds out to two,
  // and printed "– | <1 | <1". Its two ends are a step of their own; under
  // half a cent both ends print "–", and the zero stands alone.
  it.each([
    ['twelve months of eleven cents', Array(12).fill(0.11), ['–', '<1']],
    ['thirty cents, then ten', [0.3, 0.1], ['–', '<1']],
    ['a credit of thirty cents', [-0.3], ['(<1)', '–']],
    ['three tenths of a cent', [0.003], ['–']],
  ])('the twelve-month trend under a rand prints its ends once each: %s', (_name, revenue, expected) => {
    const points = (revenue as number[]).map((r, i) => ({ label: `M${i + 1} 2026`, revenue: r }));
    const svg = renderLegacyOption(legacyTrendOption(points), 718, 320);
    const ticks = [...svg.matchAll(/text-anchor="end"[^>]*transform="translate\([^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!.replace(/&lt;/g, '<'));
    expect(ticks).toEqual(expected);
  });
});
