/**
 * PAGE 8'S CLOSING FIGURE SITS IN ITS OWN GUTTER, BY A FIXED RULE, IN ONE RENDER.
 *
 * Every placement inside the plot met the line, an axis label or the plot's
 * edge on some series, and the search that followed redrew the chart until a
 * spot was free. The rule now: the grid reserves a right-hand gutter the
 * width of the closing figure, the label is drawn a fixed gap right of the
 * last point, centred on it, and moved vertically only to stay within the
 * plot. Held here through the real renderer, at every height page 8 draws the
 * line, on the reviewer's three seeds and the named shapes.
 *
 * The same renders hold the value axis: no two ticks closer than 18px (the
 * 36mm and 48mm rungs printed them four to ten apart), every tick label
 * inside the SVG (a hundred-billion tick ran off its left edge), and the
 * gutter no wider than the figure the face actually sets — zrender's table
 * charged every thousands separator a full em.
 *
 * Widths here come from `glyphCells`, the face's own advances, not from the
 * ruler production sizes the gutter with.
 */
import { describe, expect, it, vi } from 'vitest';
import { format } from 'echarts/core';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';
import { buildCashTrendChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { PAGE_WIDTH_MM } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { END_LABEL_GAP_PX } from '@/modules/accounting/services/packs/pages/packEndLabelGutter';
import { MIN_TICK_PITCH_PX } from '@/modules/accounting/services/packs/packChartAxes';
import { glyphCells } from './support/bridgeSvg';
import { outsideSvg } from './support/svgBounds';
import { liveDemoTrend } from './fixtures/liveDemoBoardPack';
import { millionsCashInput } from './fixtures/liveDemoBoardPack';

const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/charts/ssrSvg', async (original) => {
  const real = await original<typeof import('@/lib/charts/ssrSvg')>();
  return { ...real, renderChartSvg: (...args: Parameters<typeof real.renderChartSvg>) => { renders.count += 1; return real.renderChartSvg(...args); } };
});

interface Box { left: number; right: number; top: number; bottom: number }

const INK = '#15202b';
const widthOf = (text: string): number => { const cells = glyphCells(text, 0); return cells[cells.length - 1]!.right - cells[0]!.left; };
const unesc = (text: string): string => text.replace(/&#39;/g, "'").replace(/&lt;/g, '<');

function read(svg: string) {
  const W = Number(/<svg width="([\d.]+)"/.exec(svg)![1]);
  const H = Number(/<svg width="[\d.]+" height="([\d.]+)"/.exec(svg)![1]);
  const c = /<clipPath[^>]*>\s*<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)/.exec(svg)!;
  // The clip path is the grid grown by a pixel each side.
  const plot = { top: +c[2]! + 1, bottom: +c[2]! + +c[4]! - 1, left: +c[1]! + 1, right: +c[1]! + +c[3]! - 1 };
  const d = /<path d="(M[^"]*)"[^>]*stroke="#15202b"[^>]*stroke-width="2"/.exec(svg)![1]!;
  const pts = [...d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  const texts = [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].flatMap((m) => {
    const t = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(m[1]!);
    if (t === null) return [];
    const text = unesc(m[2]!);
    const width = /[A-Za-z]/.test(text) ? format.getTextRect(text, `12px ${PACK_FONT_STACK}`).width : widthOf(text);
    const ax = +t[1]! + Number(/\sx="([-\d.]+)"/.exec(m[1]!)?.[1] ?? 0);
    const ay = +t[2]! + Number(/\sy="([-\d.]+)"/.exec(m[1]!)?.[1] ?? 0);
    const anchor = /text-anchor="(\w+)"/.exec(m[1]!)?.[1];
    const left = anchor === 'end' ? ax - width : anchor === 'middle' ? ax - width / 2 : ax;
    return [{ left, right: left + width, top: ay - 6, bottom: ay + 6, text, anchor, fill: /fill="([^"]+)"/.exec(m[1]!)?.[1] }];
  });
  // The closing figure: the one text set in ink. The axis is set in grey.
  const label = texts.find((t) => t.fill === INK && t.anchor === 'start')!;
  const axis = texts.filter((t) => t !== label);
  const ticks = axis.filter((t) => t.anchor === 'end' && t.right <= plot.left);
  return { W, H, ground: label as Box & { text: string }, plot, pts, axis, ticks };
}

const overlaps = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
  && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

/** Whether a segment enters a box, exactly (Liang–Barsky). */
function enters([x1, y1]: [number, number], [x2, y2]: [number, number], b: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[x1 - x2, x1 - b.left], [x2 - x1, b.right - x1], [y1 - y2, y1 - b.top], [y2 - y1, b.bottom - y1]] as const) {
    if (p === 0) { if (q <= 0) return false; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

/** The reviewer's series generator (endlabel8.ts), by seed. */
function* series(seedValue: number, n: number): Generator<number[]> {
  let seed = seedValue;
  const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  for (let i = 0; i < n; i += 1) {
    const len = 1 + Math.floor(rnd() * 13);
    // In thousands, to the rand: a hundred rand to a hundred billion.
    const mag = Math.pow(10, -1 + rnd() * 9);
    const v = () => Math.round((rnd() - 0.5) * 2 * mag * 1000) / 1000;
    const base = Array.from({ length: len }, v);
    const kind = Math.floor(rnd() * 6);
    if (kind === 0) yield Array(len).fill(v());
    else if (kind === 1) yield [...base.slice(0, -1), Math.max(...base) + Math.abs(v())];
    else if (kind === 2) yield [...base.slice(0, -1), Math.min(...base) - Math.abs(v())];
    else yield base;
  }
}

const RUNGS_MM = [110, 72, 48, 36];
const SERIES = 1_000;
const NAMED: Array<[string, number[]]> = [
  ['under a thousand a month', [0.9, -0.4, 1.2, -0.9, 0.3]],
  ['a few thousand, unevenly', [2.4, -1.1, 0.2, 3.6]],
  ['cash past a hundred billion', [-120_000_000_000, -180_000_000_000, -90_000_000_000, -250_000_000_000].map((v) => v / 1000)],
  ['falling into the last month', [-108, -115, -118, -560, -800, -1000, -1200, -1400, -1600, -300, -548]],
  ['climbing into the last month', [-108, -115, -118, -560, -800, -1000, -1200, -1400, -1600, -900, -300]],
  ['last point at the maximum', [100, 200, 300, 900]],
  ['last point at the minimum', [500, 400, 300, -900]],
  ['flat', [250, 250, 250, 250]],
  ['a single point', [7]],
];

function check(closing: number[], heightMm: number, tag: string, failures: string[]): void {
  const trend = closing.map((v, i) => ({ ...liveDemoTrend[i % 12]!, cash: v * 1000 }));
  const before = renders.count;
  const svg = String(buildCashTrendChart(trend, PACK_SCALE, { widthMm: PAGE_WIDTH_MM.portrait, heightMm })!.svg);
  if (renders.count - before !== 1) failures.push(`${tag}: ${renders.count - before} renders`);
  const { W, H, ground, plot, pts, axis, ticks } = read(svg);
  const last = pts[pts.length - 1]!;
  if (ground.left < 0 || ground.right > W || ground.top < 0 || ground.bottom > H) failures.push(`${tag}: outside the SVG`);
  // Nothing the chart prints lies outside it — ticks, months, the unit.
  for (const out of outsideSvg(svg)) failures.push(`${tag}: ${out}`);
  if (axis.some((a) => overlaps(a, ground))) failures.push(`${tag}: over an axis label`);
  for (let i = 1; i < pts.length; i += 1) if (enters(pts[i - 1]!, pts[i]!, ground)) failures.push(`${tag}: crossed by the line`);
  // The SVG prints a path to one decimal, so a tenth of a pixel is the
  // renderer's rounding, not a placement.
  if (Math.abs(ground.left - last[0] - END_LABEL_GAP_PX) > 0.11) failures.push(`${tag}: ${(ground.left - last[0]).toFixed(2)}px from the point`);
  // The value axis: legible pitch, every label inside the SVG; and a gutter
  // the width of the figure the face sets, not of a guess at it.
  const ys = ticks.map((t) => (t.top + t.bottom) / 2).sort((a, b) => a - b);
  // A plot under one pitch has room for one label; any other prints its ends.
  if (ys.length < 2 && new Set(closing).size > 1 && plot.bottom - plot.top >= MIN_TICK_PITCH_PX) failures.push(`${tag}: ${ys.length} value ticks`);
  for (let i = 1; i < ys.length; i += 1) if (ys[i]! - ys[i - 1]! < MIN_TICK_PITCH_PX - 0.01) { failures.push(`${tag}: ticks ${(ys[i]! - ys[i - 1]!).toFixed(1)}px apart`); break; }
  if (ticks.some((t) => t.left < -0.5)) failures.push(`${tag}: a tick runs off the left edge`);
  // And no two ticks print the same figure: under a thousand a month the
  // axis read "1 | 1 | – | (1) | (1)" at R'000.
  const printed = ticks.map((t) => t.text);
  if (new Set(printed).size !== printed.length) failures.push(`${tag}: ticks repeat — ${printed.join(' | ')}`);
  const spare = W - ground.right;
  if (spare > 4) failures.push(`${tag}: ${spare.toFixed(1)}px of gutter beyond "${ground.text}"`);
  // In its gutter, right of the plot — a one-period line put it mid-plot.
  if (ground.left < plot.right - 0.11) failures.push(`${tag}: the closing figure starts inside the plot`);
  // And a one-period line draws its point: a line of one point is nothing.
  if (closing.length === 1 && !/<path d="M[^"]*A[^"]*"[^>]*fill="#15202b"/.test(svg)) failures.push(`${tag}: its one point is not drawn`);
  // What is held inside the plot is the label's box as zrender lays it out:
  // a 14px line and its halo, two pixels either side of the 12px type.
  const LEAD = 2;
  const centre = (ground.top + ground.bottom) / 2;
  if (ground.bottom - ground.top + LEAD * 2 > plot.bottom - plot.top) {
    // A plot shorter than the label: centred on the plot.
    if (Math.abs(centre - (plot.top + plot.bottom) / 2) > 0.11) failures.push(`${tag}: not centred on a plot too short for it`);
    return;
  }
  const clamped = ground.top - LEAD <= plot.top + 0.11 || ground.bottom + LEAD >= plot.bottom - 0.11;
  if (Math.abs(centre - last[1]) > 0.11 && !clamped) failures.push(`${tag}: ${(centre - last[1]).toFixed(2)}px off the point, unclamped`);
  if (ground.top < plot.top - 0.11 || ground.bottom > plot.bottom + 0.11) failures.push(`${tag}: outside the plot's height`);
}

describe("page 8's closing-cash label", () => {
  for (const seed of [99_173, 5_150, 271_828]) {
    it(`holds on seed ${seed}, at every height`, () => {
      const failures: string[] = [];
      const before = renders.count;
      let k = 0;
      // A thousand series, each at ALL FOUR heights the page draws the line.
      for (const closing of series(seed, SERIES)) {
        for (const h of RUNGS_MM) check(closing, h, `#${k} ${h}mm ${JSON.stringify(closing)}`, failures);
        k += 1;
      }
      expect(failures.slice(0, 6), `${failures.length} failures`).toEqual([]);
      // And every one of them was one render — four thousand charts.
      expect(renders.count - before).toBe(SERIES * RUNGS_MM.length);
    }, 300_000);
  }

  it.each(NAMED)('holds for a series %s, at every height', (_name, closing) => {
    const failures: string[] = [];
    for (const h of RUNGS_MM) check(closing, h, `${h}mm`, failures);
    expect(failures).toEqual([]);
  });

  it('holds for the millions-cash pack\'s own series', () => {
    const failures: string[] = [];
    for (const h of RUNGS_MM) check(millionsCashInput.trend.map((p) => p.cash / 1000), h, `${h}mm`, failures);
    expect(failures).toEqual([]);
  });
});
