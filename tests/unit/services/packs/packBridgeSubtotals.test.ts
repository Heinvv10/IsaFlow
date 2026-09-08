/**
 * THE BRIDGE DREW TWO OF THE STATEMENT'S THREE SUBTOTALS AND NAMED NEITHER
 * THE THIRD NOR ITS ABSENCE.
 *
 * Page 6 tabulates gross profit, operating profit and net profit; its bridge
 * drew the first and the last. A reader tracing the bars past Other Income is
 * standing ON operating profit — the running total there is that figure by
 * `aggregateFigures`' own definition — and the chart put no mark on it, while
 * the sheet's footnote listed the lines it omits for being nil. A closed list
 * that omits one of its own omissions is the enumeration defect.
 *
 * DRAWN ONLY WHERE THE WALK AGREES WITH THE ROW. The classifier issues its
 * own `operatingProfit` and this walk derives one; where they differ the bar
 * would be a second figure for one line, so it is not drawn — the same
 * refusal `decomposition` makes when two readings of the control account
 * disagree.
 */
import { describe, expect, it } from 'vitest';
import { buildProfitWaterfall } from '@/modules/accounting/services/reports/waterfallDataService';
import { buildProfitWaterfallChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { brightsphereLiveSet } from './fixtures/boardPackInputs';
import { liveDemoSet } from './fixtures/liveDemoBoardPack';

const COMPANIES: Record<string, PackFigureSet> = {
  'the demo company': liveDemoSet,
  Brightsphere: brightsphereLiveSet,
};

describe('the bridge draws the subtotal a reader is standing on', () => {
  for (const [company, set] of Object.entries(COMPANIES)) {
    it(`marks operating profit on ${company}`, () => {
      const chart = buildProfitWaterfallChart(set, PACK_SCALE);
      const bars = chart.waterfallBars ?? [];
      const operating = bars.find((b) => b.label === 'Operating Profit');
      expect(operating, `${company}'s bridge draws no operating profit`).toBeDefined();
      // And it is the figure the TABLE prints on that row, not a second one.
      expect(operating!.end).toBeCloseTo(operatingProfitOf(set.current), 2);
      // Drawn from the baseline, like the other two subtotals.
      expect(operating!.start).toBe(0);
    });

    it(`still lands on net profit on ${company}`, () => {
      const bars = buildProfitWaterfallChart(set, PACK_SCALE).waterfallBars ?? [];
      expect(bars[bars.length - 1]!.label).toBe('Net Profit');
      expect(bars[bars.length - 1]!.end).toBeCloseTo(set.current.netProfit, 2);
    });
  }

  it('refuses the bar rather than printing a second figure for the row', () => {
    // The mirror: a classifier figure the walk does not reach. The bar goes,
    // and every other step is untouched.
    const steps = buildProfitWaterfall({
      revenue: 1_000_000, costOfSales: 400_000, grossProfit: 600_000,
      operatingExpenses: 200_000, otherIncome: 50_000, otherExpenses: 25_000,
      netProfit: 425_000, operatingProfit: 999_999,
    });
    expect(steps.map((s) => s.label), 'a disagreeing operating profit was drawn anyway')
      .not.toContain('Operating Profit');
    expect(steps.map((s) => s.label)).toContain('Gross Profit');
    expect(steps.map((s) => s.label)).toContain('Net Profit');
  });

  it('draws it where the caller states no figure of its own', () => {
    const steps = buildProfitWaterfall({
      revenue: 1_000_000, costOfSales: 400_000, grossProfit: 600_000,
      operatingExpenses: 200_000, otherIncome: 50_000, otherExpenses: 25_000,
      netProfit: 425_000,
    });
    const operating = steps.find((s) => s.label === 'Operating Profit');
    expect(operating, 'no classifier figure and no bar either').toBeDefined();
    expect(operating!.end).toBeCloseTo(450_000, 2);
  });
});
