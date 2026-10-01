/**
 * PAGE 8'S CLOSING FIGURE: INSIDE THE PLOT, OFF THE LINE, OFF THE AXIS LABELS.
 *
 * Above the last point it sat across a line that fell into its last month;
 * moved below, a point at the bottom of the domain took its opaque ground out
 * of the plot and over the last month's name — "Sep 2026 (part)" printed as
 * "Sep 2026 (". The reviewer's seeded series (seed 99173: four fixed shapes,
 * 4 000 random ones) are drawn through the real renderer and each label's
 * ground is read back off the SVG and held to all three.
 */
import { describe, expect, it } from 'vitest';
import { format } from 'echarts/core';
import { buildCashTrendChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';
import { liveDemoTrend } from './fixtures/liveDemoBoardPack';

interface Box { left: number; right: number; top: number; bottom: number }

function read(svg: string) {
  const g = /<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)[^"]*" transform="translate\(([-\d.]+) ([-\d.]+)\)" fill="#ffffff"/.exec(svg)!;
  const [x, y, w, h, tx, ty] = g.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ground: Box = { left: tx + x, right: tx + x + w, top: ty + y, bottom: ty + y + h };
  const c = /<clipPath[^>]*>\s*<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)/.exec(svg)!;
  const plot: Box = { left: +c[1]!, top: +c[2]!, right: +c[1]! + +c[3]!, bottom: +c[2]! + +c[4]! };
  const d = /<path d="(M[^"]*L[^"]*)"[^>]*fill="none"[^>]*stroke="#15202b"/.exec(svg)![1]!;
  const pts = [...d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  const axis: Box[] = [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)]
    .filter((m) => !m[1]!.includes(`translate(${tx} ${ty})`))
    .flatMap((m) => {
      const t = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(m[1]!);
      if (t === null) return [];
      const width = format.getTextRect(m[2]!.replace(/&#39;/g, "'"), `12px ${PACK_FONT_STACK}`).width;
      const ax = +t[1]! + Number(/\sx="([-\d.]+)"/.exec(m[1]!)?.[1] ?? 0);
      const ay = +t[2]! + Number(/\sy="([-\d.]+)"/.exec(m[1]!)?.[1] ?? 0);
      const anchor = /text-anchor="(\w+)"/.exec(m[1]!)?.[1];
      const left = anchor === 'end' ? ax - width : anchor === 'middle' ? ax - width / 2 : ax;
      return [{ left, right: left + width, top: ay - 6, bottom: ay + 6 }];
    });
  return { ground, plot, pts, axis };
}

const hit = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
  && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

function crossesLine(pts: Array<[number, number]>, b: Box): boolean {
  for (let i = 1; i < pts.length; i += 1) {
    for (let k = 0; k <= 400; k += 1) {
      const x = pts[i - 1]![0] + ((pts[i]![0] - pts[i - 1]![0]) * k) / 400;
      const y = pts[i - 1]![1] + ((pts[i]![1] - pts[i - 1]![1]) * k) / 400;
      if (x > b.left && x < b.right && y > b.top && y < b.bottom) return true;
    }
  }
  return false;
}

/** The reviewer's series, seed 99173. */
function series(): number[][] {
  let seed = 99_173;
  const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  const cases: number[][] = [
    [-108, -115, -118, -560, -800, -1000, -1200, -1400, -1600, -300, -1700],
    [500, 400, 300, 200, 100, 0, -100, -200, -300, -400, -500, -600],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0],
    [100, 90],
  ];
  for (let i = 0; i < 4000; i += 1) {
    const len = 2 + Math.floor(rnd() * 11);
    const mag = Math.pow(10, 2 + Math.floor(rnd() * 5));
    cases.push(Array.from({ length: len }, () => Math.round((rnd() - 0.5) * 2 * mag)));
  }
  return cases;
}

describe("page 8's closing-cash label", () => {
  it('lies inside the plot, clear of every axis label and of the line, on 4 004 seeded series', () => {
    const failures = { outsidePlot: 0, overAxisLabel: 0, crossesLine: 0 };
    const examples: string[] = [];
    for (const closing of series()) {
      const trend = closing.map((v, i) => ({ ...liveDemoTrend[i % 12]!, cash: v * 1000 }));
      const { ground, plot, pts, axis } = read(String(buildCashTrendChart(trend, PACK_SCALE)!.svg));
      const tag = JSON.stringify(closing);
      if (ground.left < plot.left - 0.5 || ground.right > plot.right + 0.5 || ground.top < plot.top - 0.5 || ground.bottom > plot.bottom + 0.5) {
        failures.outsidePlot += 1; if (examples.length < 6) examples.push(`outside ${tag}`);
      }
      if (axis.some((a) => hit(a, ground))) { failures.overAxisLabel += 1; if (examples.length < 6) examples.push(`axis ${tag}`); }
      if (crossesLine(pts, ground)) { failures.crossesLine += 1; if (examples.length < 6) examples.push(`line ${tag}`); }
    }
    expect(failures, examples.join('\n')).toEqual({ outsidePlot: 0, overAxisLabel: 0, crossesLine: 0 });
  }, 120_000);
});
