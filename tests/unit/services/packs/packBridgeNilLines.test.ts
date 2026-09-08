/**
 * SIX BARS ON ONE COMPANY AND SEVEN ON THE OTHER, OFF THE SAME STATEMENT.
 *
 * The bridge drew a nil Cost of Sales and dropped a nil Other Expenses —
 * `buildProfitWaterfall` gates the two "Other" lines on `!== 0` and gates
 * nothing else — so the demo company's page 6 carried six bars, Brightsphere's
 * seven, and neither sheet said which lines it had left out or why. A reader
 * holding one pack against another, or against the table three centimetres
 * above the bridge, cannot tell an omitted line from an absent one.
 *
 * One rule now: a movement whose figure for the period is nil is not drawn.
 * Subtotals are not movements and stay. The rule is only checkable if the
 * sheet states it, so page 6's bridge footnote names what it left out.
 */
import { describe, expect, it } from 'vitest';
import { buildProfitWaterfallChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereLiveInput, brightsphereSet, demoSet } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const NIL_LINES = ['Cost of Sales', 'Operating Expenses', 'Other Income', 'Other Expenses'] as const;

function nilIn(set: PackFigureSet): string[] {
  const f = set.current;
  const value: Record<(typeof NIL_LINES)[number], number> = {
    'Cost of Sales': f.costOfSales,
    'Operating Expenses': f.operatingExpenses,
    'Other Income': f.otherIncome ?? 0,
    'Other Expenses': f.otherExpenses ?? 0,
  };
  return NIL_LINES.filter((line) => value[line] === 0);
}

/** The page that carries the bridge, and every footnote on it. */
function bridgePage(doc: PackPagesDocument): { omitted: string[]; prose: string } {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'chart' || block.chart.kind !== 'waterfall') continue;
      if (block.chart.omittedBars === undefined) continue;
      return { omitted: block.chart.omittedBars, prose: page.footnotes.map((f) => f.text).join(' ') };
    }
  }
  throw new Error('no bridge in this pack');
}

describe('one rule for a bridge line with no figure', () => {
  for (const [company, set] of Object.entries({ 'the demo company': demoSet, Brightsphere: brightsphereSet })) {
    it(`draws no nil movement on ${company}`, () => {
      const chart = buildProfitWaterfallChart(set, PACK_SCALE);
      const drawn = (chart.waterfallBars ?? []).map((bar) => bar.label);
      for (const line of nilIn(set)) {
        expect(drawn, `${line} is nil and still drawn`).not.toContain(line);
        expect(chart.omittedBars, `${line} is nil and unaccounted for`).toContain(line);
      }
      // AND EVERY LINE THAT HAS A FIGURE IS STILL THERE — the mirror case, so
      // the rule cannot be satisfied by dropping bars generally.
      for (const line of NIL_LINES.filter((l) => !nilIn(set).includes(l))) {
        expect(drawn, `${line} carries a figure and is not drawn`).toContain(line);
      }
    });
  }

  it('applies the same rule to both companies', () => {
    const rule = (set: PackFigureSet): boolean => {
      const chart = buildProfitWaterfallChart(set, PACK_SCALE);
      const drawn = new Set((chart.waterfallBars ?? []).map((b) => b.label));
      return NIL_LINES.every((line) => drawn.has(line) === !nilIn(set).includes(line));
    };
    expect(rule(demoSet), 'the demo bridge follows a different rule').toBe(true);
    expect(rule(brightsphereSet), 'the Brightsphere bridge follows a different rule').toBe(true);
    // The fixtures differ in WHICH line is nil, which is what made the two
    // sheets disagree in the first place.
    expect(nilIn(demoSet)).not.toEqual(nilIn(brightsphereSet));
  });

  for (const [company, input] of Object.entries({
    'the demo company': liveDemoShortPanelsInput,
    Brightsphere: brightsphereLiveInput,
  })) {
    it(`names what it left out on ${company}'s own sheet`, () => {
      const { omitted, prose } = bridgePage(buildBoardPackPages(input));
      if (omitted.length === 0) {
        expect(prose, 'a bridge that dropped nothing still explains a dropped line')
          .not.toContain('nil figure for the period is not drawn');
        return;
      }
      expect(prose).toContain('A line with a nil figure for the period is not drawn');
      for (const line of omitted) expect(prose, `${line} was dropped silently`).toContain(line);
    });
  }
});
