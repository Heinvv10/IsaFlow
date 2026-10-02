/**
 * THE 48mm RUNG UNDER A LONG PLUG NAME DRAWS THE BRIDGE, NOT THE HEADROOM.
 *
 * "Other, not separately captured" under the bars leaves the bottom rung's
 * bridge a plot of about 49px, and the figures' headroom is most of it. Each
 * widening of the axis for that headroom coarsened its round step and the
 * coarser step needed more widening: a company with revenue of R1.93m drew
 * its axis from (10 000) to 10 000 and its tallest bar 4.7px tall, where an
 * earlier build drew 16px. And a pixel of headroom the layout asked for that
 * the placement never used held other axes a whole step too wide.
 *
 * The reviewer's ordinary companies (round 12, `rung48.ts`): positive revenue,
 * costs under it, and on most of them a small plug for interest and tax.
 * Every one is drawn with its tallest bar at least a fifth of the plot —
 * every one was over a fifth on the fix, and as little as 6% before — and
 * every figure whole and legible.
 */
import { describe, expect, it } from 'vitest';
import { buildCashWaterfallChart, buildProfitWaterfallChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { HALF } from '@/modules/accounting/services/packs/pages/packChartRungs';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { demoSet, figures } from './fixtures/boardPackInputs';
import { bars, clipRect, illegible, textOnText } from './support/bridgeSvg';

function* companies(seedValue: number, n: number): Generator<{ plug: boolean; set: PackFigureSet }> {
  let s = seedValue >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const U = (a: number, b: number) => a + (b - a) * rnd();
  const r2 = (x: number) => Math.round(x * 100) / 100;
  for (let i = 0; i < n; i += 1) {
    const rev = r2(Math.exp(U(Math.log(1e5), Math.log(2e9))));
    const cos = r2(rev * U(0.2, 0.75)); const opex = r2(rev * U(0.05, 0.4));
    const oi = rnd() < 0.5 ? 0 : r2(rev * U(0, 0.05)); const oe = rnd() < 0.5 ? 0 : r2(rev * U(0, 0.08));
    const plug = rnd() < 0.6 ? r2(-rev * U(0.005, 0.08)) : 0;
    const f = { revenue: rev, costOfSales: cos, operatingExpenses: opex, otherIncome: oi, otherExpenses: oe, netProfit: r2(rev - cos - opex + oi - oe + plug) };
    yield { plug: plug !== 0, set: { current: figures({ ...f, operatingProfit: undefined }), prior: null } as PackFigureSet };
    // The reviewer's harness draws a cash bridge off the same draws: spend them.
    for (let k = 0; k < 5; k += 1) U(0, 1);
  }
}

describe('the bottom rung, under a long plug name', () => {
  it.each([424_242, 20_260_930])('draws every ordinary company\'s bridge at least a fifth of the plot tall — seed %i', (seed) => {
    const found: string[] = [];
    let plugged = 0;
    for (const { plug, set } of companies(seed, 250)) {
      const svg = String(buildProfitWaterfallChart(set, PACK_SCALE, false, HALF).svg);
      plugged += plug ? 1 : 0;
      const tag = `revenue ${set.current.revenue}${plug ? ' with a plug' : ''}`;
      const tallest = Math.max(...bars(svg).map((b) => b.bottom - b.top));
      const plot = clipRect(svg).height;
      if (tallest < plot / 5) found.push(`${tag}: tallest bar ${tallest.toFixed(1)}px of a ${plot}px plot`);
      for (const fault of [...illegible(svg), ...textOnText(svg)]) found.push(`${tag}: ${fault}`);
    }
    expect(plugged, 'no company carries a plug, so the long name is not under test').toBeGreaterThan(100);
    expect(found.slice(0, 5), `${found.length} faults`).toEqual([]);
  }, 60_000);

  it('asks the axis for no headroom the figures do not use: a R117m revenue bar keeps its 57px', () => {
    // Its figure sits exactly at the top of a 0..150 000 axis. The layout once
    // asked a pixel more than the placement used, ran the axis to 200 000 and
    // then a step under zero, and drew the bar at 28px.
    const f = { revenue: 117_070_372.96, costOfSales: 28_025_157.05, operatingExpenses: 43_847_724.76, otherIncome: 1_519_362.75, otherExpenses: 0, netProfit: 46_716_853.9 };
    const svg = String(buildProfitWaterfallChart({ current: figures({ ...f, operatingProfit: undefined }), prior: null } as PackFigureSet, PACK_SCALE, false, HALF).svg);
    expect(Math.max(...bars(svg).map((b) => b.bottom - b.top))).toBeGreaterThan(55);
    expect(illegible(svg)).toEqual([]);
  });

  it('draws page 8\'s cash bridge on a three-step plot on the axis its figures need, not a round one four times too wide', () => {
    // Opening 919, flows of 618, (222) and (585), 23 unexplained, at R'000:
    // a round axis from (2 000) to 4 000 drew the tallest bar 9.8px tall.
    const [open, op, inv, fin, res] = [918_617.13, 617_918.97, -222_401.56, -584_839.76, 23_165.56];
    const bridge = buildCashWaterfallChart({ ...demoSet, current: figures({ operatingCashFlow: op, investingCashFlow: inv, financingCashFlow: fin, capitalExpenditure: undefined,
      cash: open + op + inv + fin + res }), prior: figures({ cash: open }) }, PACK_SCALE);
    if (!bridge.drawn) throw new Error('no cash bridge is drawn, so nothing is under test');
    const svg = String(bridge.chart.svg);
    expect(Math.max(...bars(svg).map((b) => b.bottom - b.top))).toBeGreaterThan(30);
    expect([...illegible(svg), ...textOnText(svg)]).toEqual([]);
  });
});
