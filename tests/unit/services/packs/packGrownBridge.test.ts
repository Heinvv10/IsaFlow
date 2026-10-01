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
 * AND AT THE HALF RUNG IT HAPPENED AGAIN, by design that time: 72mm took the
 * full chrome, so a bridge with room for 72 had a smaller plot than one with
 * room for 71. A chart that gets taller never gets a smaller plot — so the
 * print bridges take the chrome that leaves the taller plot at every height,
 * and with these margins that is the compact one throughout.
 *
 * So, for every whole millimetre from the bottom rung to the top one, with
 * and without a plug, through the functions pages 6 and 8 call: the plot is
 * never shorter than a millimetre less gave, the tallest bar is never drawn
 * shorter, and the profit bridge's axis stays near the figures it carries.
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

function measure(svg: string) {
  const drawn = bars(svg);
  const ticks = yAxisTicks(svg).map((t) => tickValue(t.text)).sort((a, b) => a - b);
  return {
    plotPx: clipRect(svg).height,
    tallestBarPx: Math.max(...drawn.map((b) => b.bottom - b.top)),
    ticks,
    px: drawnFigures(svg)[0]!.px,
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
    // two rungs above it among them.
    expect(taken.length).toBeGreaterThan(40);
    expect(taken).toContain(MID.heightMm);
    expect(taken).toContain(FULL.heightMm);
  });

  it('is drawn larger at each rung of the ladder than at the one below', () => {
    for (const [, set] of SETS) {
      const [bottom, half, full] = [HALF, MID, FULL].map((box) => measure(String(buildProfitWaterfallChart(set, PACK_SCALE, false, box).svg)));
      expect(half!.plotPx).toBeGreaterThan(bottom!.plotPx);
      expect(full!.plotPx).toBeGreaterThan(half!.plotPx);
    }
  });

  it('takes the chrome that leaves the taller plot — and that is the compact one, for any names', () => {
    // The premise the builders rely on. If the two chromes are ever changed
    // so that the full one wins somewhere, this says so.
    const names = ['Revenue', 'Operating Expenses', 'Other, not separately captured'];
    const margin = (chrome: { top: number; bottom: number; labelPx: number }) => chrome.top + Math.max(chrome.bottom, categoryDepthPx(names, chrome.labelPx));
    expect(margin(WATERFALL_CHROME.compact)).toBeLessThan(margin(WATERFALL_CHROME.full));
    // With short names too, where each chrome's own floor is the margin.
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
    expect(taken.length).toBeGreaterThan(30);
    expect(taken).toContain(MID.heightMm);
  });
});
