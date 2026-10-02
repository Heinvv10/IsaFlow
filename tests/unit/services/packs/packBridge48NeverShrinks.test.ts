/**
 * A 48MM BRIDGE IS NEVER DRAWN SMALLER THAN ITS PARENT DREW IT, AND AN
 * ALL-POSITIVE BRIDGE'S AXIS GOES BELOW ZERO ONLY FOR A FIGURE.
 *
 * Round 13 stopped the axis asking a pixel more room than the figures'
 * placement needs. On a plot of 64 to 81px that pixel had been pushing the
 * settle loop to a coarser ask; without it the finer round axis settled, and
 * 3 of 1 600 unplugged profit bridges and 3 of 4 000 cash bridges drew at 62
 * to 83% of the parent's height. One, an all-positive P&L, settled at
 * (200 000)..600 000: two figures overran the zero line by 0.1 and 1.8px,
 * and the axis took a whole step below zero to hold them, where 0..500 000
 * held every figure. The parent's heights (6276b10c2) are frozen in
 * `fixtures/bridge48Parent`, measured as the reviewer's `rung48.ts` did.
 */
import { describe, expect, it } from 'vitest';
import { buildProfitWaterfallChart } from '@/modules/accounting/services/packs/pages/packProfitBridge';
import { buildCashWaterfallChart } from '@/modules/accounting/services/packs/pages/packCashBridge';
import { HALF } from '@/modules/accounting/services/packs/pages/packChartRungs';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { figures } from './support/bridgeSvg';
import { yAxisTicks } from './support/svgTicks';
import { PARENT_TALLEST_PX } from './fixtures/bridge48Parent';

const SCALE = "R'000" as const;

/** The reviewer's measure: the plot's height, and the tallest bar in it. */
function tallestPx(svg: string): number {
  const at = svg.indexOf('<g clip-path');
  const group = svg.slice(at, svg.indexOf('</g>', at));
  const heights: number[] = [];
  for (const m of group.matchAll(/<path d="M[-\d.e]+ [-\d.e]+l[-\d.e]+ 0l0 ([-\d.e]+)l[-\d.e]+ 0Z" fill="([^"]+)"[^>]*ecmeta_data_index="(\d+)"/g)) {
    if (m[2]!.toLowerCase() !== '#ffffff' && heights[Number(m[3])] === undefined) heights[Number(m[3])] = Number(m[1]);
  }
  return Math.max(...heights.filter((h) => h !== undefined));
}

/** Where the axis's zero is drawn, from its two end ticks. */
function zeroY(svg: string): number {
  const value = (text: string) => (text.startsWith('(') ? -1 : 1) * Number(text.replace(/[()\s ]/g, '').replace('–', '0'));
  const ticks = yAxisTicks(svg).map((t) => ({ y: t.y, v: value(t.text) }));
  const [a, b] = [ticks[0]!, ticks[ticks.length - 1]!];
  return a.y + ((b.y - a.y) * (0 - a.v)) / (b.v - a.v);
}

/** An axis below zero under bars that are all above it holds a figure there. */
function belowZeroFault(svg: string, allPositive: boolean): string[] {
  if (!allPositive || !yAxisTicks(svg).some((t) => t.text.startsWith('('))) return [];
  const zero = zeroY(svg);
  return figures(svg).some((f) => f.y + f.px / 2 > zero + 0.01) ? [] : ['the axis runs below zero and no figure is drawn there'];
}

const profitSvg = (current: Record<string, number>) =>
  String(buildProfitWaterfallChart({ current, prior: null } as unknown as PackFigureSet, SCALE, false, HALF).svg);
const cashSvg = (cset: unknown) => {
  const c = buildCashWaterfallChart(cset as PackFigureSet, SCALE) as { drawn: boolean; chart: { svg: unknown } };
  return c.drawn ? String(c.chart.svg) : null;
};

/** The reviewer's generator (`rung48.ts`), draw for draw. */
function* companies(seed: number, n: number) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const U = (a: number, b: number) => a + (b - a) * rnd();
  const logU = (a: number, b: number) => Math.exp(U(Math.log(a), Math.log(b)));
  const r2 = (x: number) => Math.round(x * 100) / 100;
  for (let i = 0; i < n; i += 1) {
    const rev = r2(logU(1e5, 2e9)); const cos = r2(rev * U(0.2, 0.75)); const opex = r2(rev * U(0.05, 0.4));
    const oi = rnd() < 0.5 ? 0 : r2(rev * U(0, 0.05)); const oe = rnd() < 0.5 ? 0 : r2(rev * U(0, 0.08));
    const plug = rnd() < 0.6 ? r2(-rev * U(0.005, 0.08)) : 0;
    const profit = { revenue: rev, costOfSales: cos, operatingExpenses: opex, otherIncome: oi, otherExpenses: oe, netProfit: r2(rev - cos - opex + oi - oe + plug) };
    const open = r2(rev * U(0.02, 0.5)); const op = r2(rev * U(-0.2, 0.3)); const inv = r2(-rev * U(0, 0.2)); const fin = r2(rev * U(-0.2, 0.2));
    const res = rnd() < 0.5 ? r2(rev * U(-0.03, 0.03)) : 0;
    const cash = { current: { operatingCashFlow: op, investingCashFlow: inv, financingCashFlow: fin, cash: r2(open + op + inv + fin + res) }, prior: { cash: open } };
    const profitPositive = Math.min(rev, rev - cos, rev - cos - opex, rev - cos - opex + oi, rev - cos - opex + oi - oe, profit.netProfit) >= 0;
    const cashPositive = Math.min(open, open + op, open + op + inv, open + op + inv + fin, cash.current.cash) >= 0;
    yield { i, plugged: plug !== 0, profit, profitPositive, cash, cashPositive };
  }
}

describe('a 48mm bridge', () => {
  it('an all-positive P&L the parent drew 0..500 000 is not given (200 000) below zero', () => {
    const svg = profitSvg({ revenue: 421204404.62, costOfSales: 190866456.46, operatingExpenses: 99621504.72, otherIncome: 0, otherExpenses: 13917677.4, netProfit: 116798766.04 });
    expect(yAxisTicks(svg).map((t) => t.text.replace(/\u00a0/g, ' '))).toEqual(['500 000', '–']);
    expect(tallestPx(svg)).toBeGreaterThanOrEqual(61.5);
  });

  it('a cash bridge the parent drew 41.3px tall is not drawn 34.4', () => {
    const svg = cashSvg({ current: { operatingCashFlow: 21936.41, investingCashFlow: -22745.97, financingCashFlow: -8855.05, cash: 15823.92 }, prior: { cash: 25488.53 } })!;
    expect(tallestPx(svg)).toBeGreaterThanOrEqual(41.3);
  });

  it.each(Object.keys(PARENT_TALLEST_PX).map(Number))('is never drawn smaller than the parent drew it, and crosses zero only for a figure — seed %i', (seed) => {
    const parent = PARENT_TALLEST_PX[seed]!;
    const faults: string[] = [];
    for (const c of companies(seed, parent.profit.length)) {
      // The fixture is the generator's: null exactly where it drew a plug.
      expect(parent.profit[c.i] === null, `draw ${c.i} is out of step with the fixture`).toBe(c.plugged);
      const was = parent.profit[c.i];
      if (was !== null && was !== undefined) {
        const svg = profitSvg(c.profit);
        const now = tallestPx(svg);
        if (now < was - 0.05) faults.push(`profit #${c.i}: ${now}px, the parent ${was}px`);
        faults.push(...belowZeroFault(svg, c.profitPositive).map((f) => `profit #${c.i}: ${f}`));
      }
      const svg = cashSvg(c.cash);
      const wasCash = parent.cash[c.i];
      if (svg === null || wasCash === null || wasCash === undefined) continue;
      const now = tallestPx(svg);
      if (now < wasCash - 0.05) faults.push(`cash #${c.i}: ${now}px, the parent ${wasCash}px`);
      faults.push(...belowZeroFault(svg, c.cashPositive).map((f) => `cash #${c.i}: ${f}`));
    }
    expect(faults).toEqual([]);
  }, 120_000);
});
