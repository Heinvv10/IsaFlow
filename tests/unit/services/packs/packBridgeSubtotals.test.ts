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
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput, brightsphereLiveSet } from './fixtures/boardPackInputs';
import { liveDemoSet, liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';

const LIVE_INPUTS: Record<string, BoardPackInput> = {
  'the demo company': liveDemoRenderedInput,
  Brightsphere: brightsphereLiveInput,
};

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
    const { steps } = buildProfitWaterfall({
      revenue: 1_000_000, costOfSales: 400_000, grossProfit: 600_000,
      operatingExpenses: 200_000, otherIncome: 50_000, otherExpenses: 25_000,
      netProfit: 425_000, operatingProfit: 999_999,
    });
    expect(steps.map((s) => s.label), 'a disagreeing operating profit was drawn anyway')
      .not.toContain('Operating Profit');
    expect(steps.map((s) => s.label)).toContain('Gross Profit');
    expect(steps.map((s) => s.label)).toContain('Net Profit');
  });

  it('tells the caller which subtotal it refused, so page 6 can name it', () => {
    // THE OMISSION TRAVELS WITH THE STEPS. The docblock said "the caller is
    // told and page 6 names the omission instead" while the function returned
    // only `WaterfallStep[]`, and page 6's omission sentence was a hand-written
    // list of the five MOVEMENT lines — so this subtotal could be dropped from
    // the bridge with nothing on the sheet saying so.
    const refused = buildProfitWaterfall({
      revenue: 1_000_000, costOfSales: 400_000, grossProfit: 600_000,
      operatingExpenses: 200_000, otherIncome: 50_000, otherExpenses: 25_000,
      netProfit: 425_000, operatingProfit: 999_999,
    });
    expect(refused.omitted).toContain('Operating Profit');
    const drawn = buildProfitWaterfall({
      revenue: 1_000_000, costOfSales: 400_000, grossProfit: 600_000,
      operatingExpenses: 200_000, otherIncome: 50_000, otherExpenses: 25_000,
      netProfit: 425_000, operatingProfit: 450_000,
    });
    expect(drawn.omitted, 'a subtotal that WAS drawn is reported as omitted')
      .not.toContain('Operating Profit');
  });

  it('reports a nil movement as omitted through the same value', () => {
    // M2: the nil-line rule had two implementations — this one, and page 6's
    // own predicate over its own list. One rule, one reading.
    const { steps, omitted } = buildProfitWaterfall({
      revenue: 1_000_000, costOfSales: 0, grossProfit: 1_000_000,
      operatingExpenses: 200_000, otherIncome: 0, otherExpenses: 25_000,
      netProfit: 775_000,
    });
    expect(omitted).toEqual(['Cost of Sales', 'Other Income']);
    expect(steps.map((s) => s.label)).not.toContain('Cost of Sales');
    expect(steps.map((s) => s.label)).not.toContain('Other Income');
  });

  it('carries a refused subtotal into page 6\'s omitted bars', () => {
    // The chart's `omittedBars` is what `bridgeSignFootnote` prints, so this
    // is the whole path from the builder's refusal to the sheet's sentence.
    for (const [company, set] of Object.entries(COMPANIES)) {
      const bent: PackFigureSet = {
        ...set,
        current: { ...set.current, operatingProfit: operatingProfitOf(set.current) + 111_111 },
      };
      const chart = buildProfitWaterfallChart(bent, PACK_SCALE);
      expect(chart.omittedBars, `${company}: the bridge dropped the subtotal in silence`)
        .toContain('Operating Profit');
    }
  });

  /**
   * AND THE SHEET SAYS IT IN THE RIGHT WORDS, ON A PAGE THAT STILL FITS.
   *
   * The omission sentence read "A line with a nil figure for the period is
   * not drawn: …", which is false of this subtotal — it is refused on a
   * disagreement with the row three centimetres above it, not on a nil. The
   * clause costs page 6 a footnote line, so the page is measured with it.
   */
  for (const [company, input] of Object.entries(LIVE_INPUTS)) {
    it(`names the refused subtotal in its own words on ${company}`, () => {
      const bentSet: PackFigureSet = {
        ...input.set,
        current: {
          ...input.set.current,
          operatingProfit: operatingProfitOf(input.set.current) + 111_111,
        },
      };
      const doc = buildBoardPackPages({ ...input, set: bentSet });
      const page = doc.pages.find((p) => p.navLabel === 'Income statement');
      expect(page, 'the pack has no income statement').toBeDefined();
      const notes = page!.footnotes.map((f) => f.text).join(' ');
      expect(notes, `${company}: the subtotal omission is not stated`)
        .toContain('The operating profit subtotal is not drawn');
      expect(notes, `${company}: a subtotal refused on a disagreement is called nil`)
        .not.toMatch(/nil figure for the period is not drawn: [^.]*Operating Profit/);
      // AND THE SHEET STILL COMPOSES. A required footnote that does not fit
      // refuses the whole pack, so the clause is measured rather than
      // assumed — `fitPageToBox` has already run on the pages above.
      expect(page!.blocks.length, `${company}: page 6 composed empty`).toBeGreaterThan(0);
      expect(notes).not.toContain(OMISSION_MARK);
    });
  }

  it('draws it where the caller states no figure of its own', () => {
    const { steps } = buildProfitWaterfall({
      revenue: 1_000_000, costOfSales: 400_000, grossProfit: 600_000,
      operatingExpenses: 200_000, otherIncome: 50_000, otherExpenses: 25_000,
      netProfit: 425_000,
    });
    const operating = steps.find((s) => s.label === 'Operating Profit');
    expect(operating, 'no classifier figure and no bar either').toBeDefined();
    expect(operating!.end).toBeCloseTo(450_000, 2);
  });
});
