/**
 * Page 8's cash bridge, read off the page each company composes. Split from
 * `packChartAxisLegibility.test.ts` for the 300-line cap; the helpers are
 * shared through `support/svgTicks.ts`.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { CHART_HEIGHT_MM } from '@/lib/charts/ssrSvg';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoInput } from './fixtures/liveDemoBoardPack';
import { tightestGap, yAxisTicks } from './support/svgTicks';

/**
 * PAGE 8'S CASH BRIDGE, AT THE HEIGHT THE COMPOSED PAGE GIVES IT.
 *
 * The bottom rung's plot is about eighty pixels once its title and axis
 * chrome are taken, and the demo printed six ticks in it — "(100)" to
 * "(600)", 13px apart in 10px type. `intervalsFor` asked for four, measured
 * off the box rather than the plot under its title, and `axisDomain` then
 * rounded the step DOWN to 100 and drew six anyway. Read off the page each
 * company actually composes, so whatever height the sheet settles on is the
 * one tested.
 */
describe("page 8's cash bridge", () => {
  const bridgeOn = (input: typeof liveDemoInput) => {
    const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Cash')!;
    const block = page.blocks.find((b) => b.kind === 'chart' && b.chart.id === 'cash-bridge');
    if (block === undefined || block.kind !== 'chart') throw new Error('page 8 draws no cash bridge');
    return block.chart;
  };
  // The demo fixture carries no cash flows, so its page 8 draws no bridge.
  // The v61 render did: the dev tenant's flows, which are the whole movement
  // in operating cash and nil investing and financing. Same here, off the
  // fixture's own two balances so the bridge foots and the table agrees.
  const demoWithFlows: typeof liveDemoInput = {
    ...liveDemoInput,
    set: {
      ...liveDemoInput.set,
      current: {
        ...liveDemoInput.set.current,
        operatingCashFlow: liveDemoInput.set.current.cash - liveDemoInput.set.prior!.cash,
        investingCashFlow: 0,
        financingCashFlow: 0,
      },
      // And a comparative operating figure, as the tenant had (51): with none,
      // two pages word the missing prior differently and the gate refuses
      // the pack — reported separately, not this test's subject.
      prior: { ...liveDemoInput.set.prior!, operatingCashFlow: -51_000 },
    },
  };
  for (const [name, input] of [['the live demo company', demoWithFlows], ['Brightsphere', brightsphereLiveInput]] as const) {
    it(`keeps air between its ticks for ${name}`, () => {
      const chart = bridgeOn(input);
      const ticks = yAxisTicks(String(chart.svg));
      expect(ticks.length, 'an axis needs its ends and something between').toBeGreaterThanOrEqual(3);
      const gap = tightestGap(ticks);
      expect(
        gap,
        `${chart.heightMm}mm bridge: ticks ${gap.toFixed(1)}px apart at ${ticks[0]!.size}px type — `
          + ticks.map((t) => t.text).join(' / '),
      ).toBeGreaterThanOrEqual(ticks[0]!.size * 1.5);
    });
  }

  it('takes the room the sheet has left, and nothing the sheet prints', () => {
    // The demo sheet ended in about thirty millimetres of white under a 48mm
    // bridge. The bridge grows into it; the commentary and every footnote
    // stay, and no omission note appears.
    const page = buildBoardPackPages(demoWithFlows).pages.find((p) => p.navLabel === 'Cash')!;
    expect(bridgeOn(demoWithFlows).heightMm).toBeGreaterThan(CHART_HEIGHT_MM.inline);
    expect(bridgeOn(demoWithFlows).heightMm).toBeLessThanOrEqual(CHART_HEIGHT_MM.half);
    expect(page.footnotes.map((f) => f.text).join(' ')).not.toMatch(/Not printed on this page/);
    expect(page.blocks.some((b) => b.kind === 'disclosure' && b.disclosure.heading === 'Commentary')).toBe(true);
  });
});

