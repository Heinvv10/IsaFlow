/**
 * A BRIDGE GROWN INTO SPARE PAPER IS A BIGGER PICTURE, OR IT IS NOT TAKEN.
 *
 * Page 6 steps its bridge down a ladder — 110, 72, 48mm — and then grows it
 * back into whatever the page has left. A millimetre over 48 the grown chart
 * left the compact chrome for the full one: 12px names and 28px more of
 * margin. With a long plug name ("Other, not separately captured") the plot
 * fell from about 75px to under 40, the value axis ran to a hundred billion
 * to hold the figures, and every bar was drawn as a one-pixel rule. It was
 * accepted because its BOX was taller.
 *
 * AND THE RUNG ABOVE MUST STILL BE THE BIGGER PICTURE. Below the half rung a
 * grown bridge keeps the compact chrome; the rungs at 72 and 110mm take the
 * full one, with 12px category names — the pack's look. The compact chrome
 * leaves 28-44px more plot in the same box, so grown far enough toward 72 a
 * compact bridge would out-draw the 72mm rung, and a page with a millimetre
 * more room would get the smaller picture. It is grown only while it is
 * still smaller than the rung above it.
 *
 * So, for every whole millimetre of room from the bottom rung to the top
 * one, with and without a plug, through the functions pages 6 and 8 call:
 * the plot is never shorter than a millimetre less gave, the tallest bar is
 * never drawn shorter, the profit bridge's axis stays near its figures — and
 * the rungs are drawn in the full chrome with 12px names.
 */
import { describe, expect, it } from 'vitest';
import { buildCashWaterfallChart, buildProfitWaterfallChart, cashBridgeAtHeight, profitBridgeAtHeight } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { categoryDepthPx, WATERFALL_CHROME } from '@/modules/accounting/services/packs/packWaterfallDomain';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { FULL, HALF, MID } from '@/modules/accounting/services/packs/pages/packChartRungs';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { demoSet, figures } from './fixtures/boardPackInputs';
import { liveDemoSet } from './fixtures/liveDemoBoardPack';
import { bars, clipRect, figures as drawnFigures } from './support/bridgeSvg';
import { yAxisTicks } from './support/svgTicks';

/** A loss with a large plug: the long-named step the collapse needed. */
const plugLossSet: PackFigureSet = {
  ...demoSet,
  current: figures({ revenue: 1_250_000, costOfSales: 900_000, operatingExpenses: 610_000, otherIncome: 0, otherExpenses: 0,
    operatingProfit: -260_000, netProfit: -1_480_000 }),
};
const SETS: Array<[string, PackFigureSet, boolean]> = [
  ['the demo company, with its plug', demoSet, true],
  ['a loss with a large plug', plugLossSet, true],
  ['the live demo company, which foots without one', liveDemoSet, false],
];

/** A tick's printed figure as a number of thousands. */
const tickValue = (text: string): number => {
  const digits = text.replace(/[()\s ]/g, '');
  const n = digits === '–' ? 0 : Number(digits);
  return text.startsWith('(') ? -n : n;
};

/** The size the category names under the bars are set at. */
const namePx = (svg: string): number[] => [...new Set([...svg.matchAll(/<text[^>]*font-size:([\d.]+)px[^>]*transform="matrix\(/g)].map((m) => Number(m[1])))];

function measure(svg: string) {
  const drawn = bars(svg);
  const ticks = yAxisTicks(svg).map((t) => tickValue(t.text)).sort((a, b) => a - b);
  return {
    plotPx: clipRect(svg).height,
    tallestBarPx: Math.max(...drawn.map((b) => b.bottom - b.top)),
    ticks,
    px: drawnFigures(svg)[0]!.px,
    plotTop: clipRect(svg).top,
    namePx: namePx(svg),
  };
}

describe('a bridge grown from the bottom rung', () => {
  it.each(SETS)('%s: the plot and the bars only ever grow, and the axis stays on the figures', (_name, set, plugged) => {
    const bottom = buildProfitWaterfallChart(set, PACK_SCALE, false, HALF);
    expect(bottom.waterfallBars!.some((b) => b.label === 'Other, not separately captured')).toBe(plugged);
    const dataThousands = bottom.waterfallBars!.flatMap((b) => [b.start, b.end]).map((v) => v / 1000);
    const [low, high] = [Math.min(0, ...dataThousands), Math.max(0, ...dataThousands)];

    let kept = bottom;
    let before = measure(String(bottom.svg));
    const taken: number[] = [];
    for (let mm = HALF.heightMm + 1; mm <= FULL.heightMm; mm += 1) {
      // What page 6 does with `mm` of room: grow, and keep the larger picture.
      const grown = profitBridgeAtHeight(set, PACK_SCALE, false, mm, kept);
      if (grown !== null && grown.heightMm > kept.heightMm) { kept = grown; taken.push(mm); }
      const now = measure(String(kept.svg));
      expect(now.plotPx, `${mm}mm: the plot shrank from ${before.plotPx}px`).toBeGreaterThanOrEqual(before.plotPx - 0.01);
      expect(now.tallestBarPx, `${mm}mm: the tallest bar shrank from ${before.tallestBarPx}px`).toBeGreaterThanOrEqual(before.tallestBarPx - 0.01);
      // Within two gridline steps of the figures either side — room for a
      // figure set outside its bar, and no more. It ran to a hundred billion.
      const step = now.ticks.length > 1 ? now.ticks[1]! - now.ticks[0]! : Infinity;
      expect(now.ticks[0]!, `${mm}mm: the axis runs to ${now.ticks[0]} under figures from ${low}`).toBeGreaterThanOrEqual(low - 2 * step - 1);
      expect(now.ticks[now.ticks.length - 1]!, `${mm}mm: the axis runs to ${now.ticks[now.ticks.length - 1]} over figures to ${high}`).toBeLessThanOrEqual(high + 2 * step + 1);
      // And the figures keep their size: the collapse set them at 10 and 9px.
      expect(now.px, `${mm}mm`).toBe(12);
      before = now;
    }
    // The page does grow it: most of these heights are a bigger picture, the
    // two rungs above it among them — and no height between 48 and 72 is
    // taken once its picture would be bigger than the 72mm rung's.
    expect(taken.length).toBeGreaterThan(35);
    expect(taken).toContain(MID.heightMm);
    expect(taken).toContain(FULL.heightMm);
    const rung = measure(String(buildProfitWaterfallChart(set, PACK_SCALE, false, MID).svg));
    for (const mm of taken.filter((h) => h < MID.heightMm)) {
      const grown = measure(String(buildProfitWaterfallChart(set, PACK_SCALE, false, { ...HALF, heightMm: mm }).svg));
      expect(grown.plotPx, `${mm}mm is taken with more plot than the 72mm rung`).toBeLessThan(rung.plotPx);
    }
  });

  it('given room past the cap, grows to the tallest height that is still smaller than the rung — not to nothing', () => {
    for (const [name, set] of SETS) {
      const bottom = buildProfitWaterfallChart(set, PACK_SCALE, false, HALF);
      const rung = measure(String(buildProfitWaterfallChart(set, PACK_SCALE, false, MID).svg));
      // 71mm of room: on the compact chrome that would out-draw the 72mm rung.
      const over = measure(String(buildProfitWaterfallChart(set, PACK_SCALE, false, { ...HALF, heightMm: 71 }).svg));
      expect(over.plotPx, `${name}: 71mm is not past the cap, so the cap is not under test`).toBeGreaterThan(rung.plotPx);
      const grown = profitBridgeAtHeight(set, PACK_SCALE, false, 71, bottom);
      expect(grown, `${name}: nothing was grown`).not.toBeNull();
      expect(grown!.heightMm).toBeGreaterThan(HALF.heightMm);
      expect(grown!.heightMm).toBeLessThan(71);
      expect(measure(String(grown!.svg)).plotPx).toBeLessThan(rung.plotPx);
      // And it is the tallest such height: a millimetre more is not taken.
      const next = measure(String(buildProfitWaterfallChart(set, PACK_SCALE, false, { ...HALF, heightMm: grown!.heightMm + 1 }).svg));
      const taller = next.plotPx < rung.plotPx && next.tallestBarPx <= rung.tallestBarPx && next.tallestBarPx >= measure(String(bottom.svg)).tallestBarPx;
      expect(taller, `${name}: ${grown!.heightMm + 1}mm would also have been a bigger picture under the rung`).toBe(false);
    }
  });

  it('draws the rungs at 72 and 110mm in the full chrome, with 12px names — and the bottom rung in the compact one', () => {
    for (const [, set] of SETS) {
      const [bottom, half, full] = [HALF, MID, FULL].map((box) => measure(String(buildProfitWaterfallChart(set, PACK_SCALE, false, box).svg)));
      expect(half!.namePx).toEqual([12]);
      expect(full!.namePx).toEqual([12]);
      expect(half!.plotTop).toBe(WATERFALL_CHROME.full.top);
      expect(full!.plotTop).toBe(WATERFALL_CHROME.full.top);
      expect(bottom!.namePx).toEqual([10]);
      expect(bottom!.plotTop).toBe(WATERFALL_CHROME.compact.top);
      expect(half!.plotPx).toBeGreaterThan(bottom!.plotPx);
      expect(full!.plotPx).toBeGreaterThan(half!.plotPx);
    }
  });

  it('caps the growth because the compact chrome leaves the taller plot in the same box', () => {
    // The fact the cap exists for. If the two chromes are ever changed so
    // that it stops being true, the cap is doing nothing and this says so.
    const names = ['Revenue', 'Operating Expenses', 'Other, not separately captured'];
    const margin = (chrome: { top: number; bottom: number; labelPx: number }) => chrome.top + Math.max(chrome.bottom, categoryDepthPx(names, chrome.labelPx));
    expect(margin(WATERFALL_CHROME.compact)).toBeLessThan(margin(WATERFALL_CHROME.full));
    expect(WATERFALL_CHROME.compact.top + WATERFALL_CHROME.compact.bottom).toBeLessThan(WATERFALL_CHROME.full.top + WATERFALL_CHROME.full.bottom);
  });
});

/** The demo company's cash bridge carries a plug; taking the unexplained
 *  movement out of closing cash gives the same bridge footing without one. */
const demoCash = buildCashWaterfallChart(demoSet, PACK_SCALE);
const footingSet: PackFigureSet = {
  ...demoSet,
  current: { ...demoSet.current, cash: demoSet.current.cash - (demoCash.drawn ? demoCash.residual : 0) },
};
const CASH_SETS: Array<[string, PackFigureSet, boolean]> = [
  ['the demo company, with an unexplained movement', demoSet, true],
  ['the same bridge footing without one', footingSet, false],
];

describe('the cash bridge, grown from the bottom rung', () => {
  it.each(CASH_SETS)('%s: the plot and the bars only ever grow', (_name, set, plugged) => {
    const bottom = buildCashWaterfallChart(set, PACK_SCALE);
    if (!bottom.drawn) throw new Error('this set draws no cash bridge, so nothing is under test');
    expect(bottom.chart.waterfallBars!.some((b) => b.uncaptured !== undefined)).toBe(plugged);
    let kept = bottom;
    let before = measure(String(bottom.chart.svg));
    const taken: number[] = [];
    for (let mm = HALF.heightMm + 1; mm <= FULL.heightMm; mm += 1) {
      const grown = cashBridgeAtHeight(set, PACK_SCALE, mm, kept);
      if (grown !== null) { kept = grown; taken.push(mm); }
      if (!kept.drawn) throw new Error('the grown bridge is not drawn');
      const now = measure(String(kept.chart.svg));
      expect(now.plotPx, `${mm}mm: the plot shrank from ${before.plotPx}px`).toBeGreaterThanOrEqual(before.plotPx - 0.01);
      expect(now.tallestBarPx, `${mm}mm: the tallest bar shrank from ${before.tallestBarPx}px`).toBeGreaterThanOrEqual(before.tallestBarPx - 0.01);
      before = now;
    }
    expect(taken.length).toBeGreaterThan(20);
    expect(taken).toContain(MID.heightMm);
    // And the 72mm rung is the full chrome, 12px names, on this bridge too.
    const rung = buildCashWaterfallChart(set, PACK_SCALE, MID);
    if (!rung.drawn) throw new Error('the 72mm cash bridge is not drawn');
    expect(measure(String(rung.chart.svg)).namePx).toEqual([12]);
    expect(measure(String(rung.chart.svg)).plotTop).toBe(WATERFALL_CHROME.full.top);
  });
});
