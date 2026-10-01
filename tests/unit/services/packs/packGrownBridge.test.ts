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
 * So, for every height the page can grow the bottom rung into, with and
 * without the plug, through the function page 6 calls: the plot is never
 * shorter than a millimetre less gave, the tallest bar is never drawn
 * shorter, and the axis stays near the figures it carries.
 */
import { describe, expect, it } from 'vitest';
import { buildProfitWaterfallChart, profitBridgeAtHeight } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { HALF, MID } from '@/modules/accounting/services/packs/pages/packChartRungs';
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
    for (let mm = HALF.heightMm + 1; mm < MID.heightMm; mm += 1) {
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
    // The page does grow it: most of these heights are a bigger picture.
    expect(taken.length).toBeGreaterThan(15);
  });

  it('is never worse off at the half rung than at the bottom one', () => {
    for (const [, set] of SETS) {
      const [bottom, half] = [HALF, MID].map((box) => measure(String(buildProfitWaterfallChart(set, PACK_SCALE, false, box).svg)));
      expect(half!.plotPx).toBeGreaterThan(bottom!.plotPx);
    }
  });
});
