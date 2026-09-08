/**
 * A RED MISS SCORED ON A FIGURE THE PACK DISOWNS TWO SHEETS EARLIER.
 *
 * The demo pack's sheet 9 prints `Current ratio · (0.14) · target 1.50 ·
 * MISSED` in red; its sheet 7 says of the numerator "Current assets are
 * (464). An asset below zero is not a balance a business can hold … the
 * balances should be resolved before this sheet is relied on."
 * Brightsphere's ONLY scored target is the same ratio, on current assets of
 * (3 372), under the same words. The pack scored a judgement against figures
 * it had already qualified, and the cross-reference ran one way.
 *
 * The flag is DERIVED from `METRIC_INPUTS` — which ledger figures each ratio
 * is taken on — rather than written per row, so it cannot be true of one
 * ratio and not the next. These hold that: every scored row whose inputs are
 * qualified carries the marker, and no row whose inputs are sound does.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPagesDocument, PackScorecardRow } from '@/modules/accounting/services/packs/pages/packPageModel';
import { disownedBases } from '@/modules/accounting/services/packs/pages/packDisownedBases';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackScorecardGroup } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereLiveInput, brightsphereLiveSet } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const COMPANIES: Record<string, BoardPackInput> = {
  'the demo company': liveDemoShortPanelsInput,
  Brightsphere: brightsphereLiveInput,
};

/** The figures a scored row stands on, as this pack states them. Kept here
 *  independently of the production table so the test is not the code. */
const STANDS_ON: Record<string, ReadonlyArray<'currentAssets' | 'currentLiabilities' | 'cash' | 'accountsReceivable' | 'accountsPayable' | 'totalLiabilities' | 'inventory'>> = {
  'current ratio': ['currentAssets', 'currentLiabilities'],
  'cash ratio': ['cash', 'currentLiabilities'],
  'debtor days': ['accountsReceivable'],
  'creditor days': ['accountsPayable'],
  'debt-to-equity': ['totalLiabilities'],
  'cash conversion cycle': ['accountsReceivable', 'accountsPayable', 'inventory'],
  'operating cash flow': ['cash'],
};

function scorecardRows(doc: PackPagesDocument): PackScorecardRow[] {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind === 'scorecard') return block.groups.flatMap((g) => g.rows);
    }
  }
  throw new Error('no scorecard in this pack');
}

function scorecardFootnotes(doc: PackPagesDocument): Map<number, string> {
  const page = doc.pages.find((p) => p.navLabel === 'Scorecard')!;
  return new Map(page.footnotes.map((f) => [f.number, f.text]));
}

describe('a scored row says when its base is one the pack qualifies', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`marks every scored row standing on a disowned figure on ${company}`, () => {
      const doc = buildBoardPackPages(input);
      const rows = scorecardRows(doc);
      const notes = scorecardFootnotes(doc);
      const f = input.set.current;

      const scored = rows.filter((r) => r.status === 'met' || r.status === 'missed');
      expect(scored.length, 'nothing is scored, so nothing is being checked').toBeGreaterThan(0);

      for (const row of scored) {
        const inputs = STANDS_ON[row.metric.toLowerCase()];
        if (inputs === undefined) continue;
        const disowned = inputs.some((field) => (f[field] ?? 0) < 0);
        if (!disowned) continue;
        expect(
          row.footnote,
          `${company}: ${row.metric} is scored on a figure below zero and carries no marker`,
        ).toBeDefined();
        const text = notes.get(row.footnote!) ?? '';
        expect(text, `${company}: ${row.metric}'s marker points at a note that says nothing about its base`)
          .toMatch(/^Scored on /);
      }
    });

    it(`flags exactly the rows whose figures the pack qualifies on ${company}`, () => {
      // SET EQUALITY, in both directions. Asserting only that flagged rows
      // are qualified passes a guard that flags every scored row, which would
      // tell a director a healthy ratio is suspect — the mirror defect, and
      // one a one-directional check cannot see.
      const doc = buildBoardPackPages(input);
      const notes = scorecardFootnotes(doc);
      const f = input.set.current;
      const rows = scorecardRows(doc);

      const expected = rows
        .filter((r) => r.status === 'met' || r.status === 'missed')
        .filter((r) => {
          const inputs = STANDS_ON[r.metric.toLowerCase()];
          if (inputs === undefined) return false;
          return inputs.some((field) => (f[field] ?? 0) < 0) || inputs.includes('accountsReceivable');
        })
        .map((r) => r.metric);

      const actual = rows
        .filter((r) => r.footnote !== undefined
          && (notes.get(r.footnote) ?? '').startsWith('Scored on'))
        .map((r) => r.metric);

      expect(actual.sort()).toEqual(expected.sort());
    });
  }

  it('leaves some scored row alone, on a pack that has one to leave', () => {
    // The other direction of the set equality above: a guard that flagged
    // every scored row would satisfy it on Brightsphere, which scores exactly
    // one target and that one IS qualified. The demo scores three.
    const doc = buildBoardPackPages(liveDemoShortPanelsInput);
    const notes = scorecardFootnotes(doc);
    const scored = scorecardRows(doc).filter((r) => r.status === 'met' || r.status === 'missed');
    const flagged = scored.filter((r) => r.footnote !== undefined
      && (notes.get(r.footnote) ?? '').startsWith('Scored on'));
    expect(scored.length, 'the demo scores nothing, so nothing can be left alone').toBeGreaterThan(1);
    expect(flagged.length, 'every scored row on the demo is flagged').toBeLessThan(scored.length);
  });

  /**
   * THE MIRROR, ON A SHAPE NEITHER COMPANY HAS. Both packs happen to qualify
   * every scored ratio they carry, so removing the guard entirely leaves
   * their flagged sets unchanged — a mutation the composed-document tests
   * above cannot see. This is the row the flag must leave alone: a scored
   * metric in the table whose figures are sound.
   */
  it('leaves a scored ratio alone when the figures it stands on are sound', () => {
    const sound: PackFigureSet = {
      ...brightsphereLiveSet,
      current: {
        ...brightsphereLiveSet.current,
        cash: 900_000,
        currentLiabilities: 300_000,
        currentAssets: 1_200_000,
        accountsReceivable: 400_000,
      },
    };
    const row = (metric: string): PackScorecardGroup['rows'][number] => ({
      metric,
      actual: { value: 3, format: 'ratio', source: 'x.y' },
      target: 1,
      prior: null,
      status: 'met',
      trend: null,
      trendSvg: null,
      bulletSvg: null,
    });
    const groups: PackScorecardGroup[] = [
      { letter: 'B', name: 'Liquidity', rows: [row('Cash ratio'), row('Current ratio')] },
    ];
    expect(disownedBases(groups, sound, false)).toEqual([]);
    // And it still fires on the same shape once one of those figures turns.
    const turned: PackFigureSet = { ...sound, current: { ...sound.current, cash: -1 } };
    expect(disownedBases(groups, turned, false).map((d) => d.metric)).toEqual(['Cash ratio']);
  });

  it('is not vacuous — both companies score a ratio on a balance below zero', () => {
    for (const [company, input] of Object.entries(COMPANIES)) {
      expect(input.set.current.currentAssets, `${company} has no negative current assets`).toBeLessThan(0);
      const scored = scorecardRows(buildBoardPackPages(input))
        .filter((r) => r.metric.toLowerCase() === 'current ratio' && (r.status === 'met' || r.status === 'missed'));
      expect(scored.length, `${company} does not score the current ratio`).toBe(1);
    }
  });
});
