/**
 * THE MANAGEMENT PACK'S BRIDGE, ON THE EXACT-PLOT LAYOUT, IN ITS OWN FACE.
 *
 * The legacy view's theme sets chart text in IBM Plex Mono, wider than the
 * print face, so a layout measured in Plex Sans ran ticks like "(4 000 000)"
 * off the left edge and "Operating Expenses" past the bottom. The layout now
 * takes the measurer of the face the chart is drawn in; this renders with the
 * theme registered, as the screen does, and measures in Plex Mono — a fixed
 * 0.6em advance, so the widths are exact. Every axis label lies inside the
 * SVG, every figure on the plot and legible, and no two ticks stand closer
 * than 18px, at the heights the view is drawn at.
 */
import { describe, expect, it } from 'vitest';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { clipRect, figures, illegible, outsideClip } from './support/bridgeSvg';
import { renderLegacyBridge as render } from './support/legacyBridge';

const MONO_EM = 0.6;
const PX = 12;

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'");

/** Every way the drawn chart breaks the containment rules, as sentences. */
function breaches(svg: string, steps: WaterfallStep[], height: number): string[] {
  const out: string[] = [];
  const ticks = [...svg.matchAll(/text-anchor="end"[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\)"[^>]*>([^<]*)<\/text>/g)];
  // NOT VACUOUS: an axis that printed nothing, or names this did not find,
  // would pass every check below by having nothing to check.
  if (ticks.length < 2) out.push(`only ${ticks.length} value ticks were read`);
  for (const m of ticks) {
    const left = Number(m[1]) - unesc(m[3]!).length * MONO_EM * PX;
    if (left < -0.5) out.push(`tick "${m[3]}" starts at ${left.toFixed(1)}`);
  }
  const names = [...svg.matchAll(/transform="matrix\(0.866,-0.5,0.5,0.866,([-\d.]+),([-\d.]+)\)"[^>]*>([^<]*)<\/text>/g)];
  if (names.length !== steps.length) out.push(`${names.length} category names were read for ${steps.length} bars`);
  for (const m of names) {
    const w = unesc(m[3]!).length * MONO_EM * PX;
    const bottom = Number(m[2]) + 0.5 * w + 0.65 * PX * 0.866;
    const left = Number(m[1]) - 0.866 * w - 0.5 * PX * 0.5;
    if (bottom > height + 0.5 || left < -0.5) out.push(`name "${m[3]}" reaches ${bottom.toFixed(1)}/${height}, left ${left.toFixed(1)}`);
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

describe('the legacy bridge, in the screen\'s own face', () => {
  for (const [rev, net] of [[2_500_000, 300_000], [12_000_000, -3_000_000], [25_000_000, 2_000_000], [140_000_000, -30_000_000]]) {
    it(`keeps every axis label inside the chart at revenue ${rev}`, () => {
      const steps = bridge(rev, net);
      expect(breaches(render(steps, 900, 320), steps, 320)).toEqual([]);
    });
  }

  it('holds on 6 000 seeded bridges at 240, 320 and 420px, three widths', () => {
    const failures: string[] = [];
    let k = 0;
    for (const steps of bridges(424_242, 6_000)) {
      const height = [240, 320, 420][k % 3]!;
      const width = [480, 700, 900][Math.floor(k / 3) % 3]!;
      const svg = render(steps, width, height);
      for (const b of breaches(svg, steps, height)) failures.push(`#${k} ${width}x${height}: ${b}`);
      k += 1;
    }
    expect(failures.slice(0, 6), `${failures.length} breaches`).toEqual([]);
  }, 180_000);
});
