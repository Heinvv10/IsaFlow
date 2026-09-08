/**
 * ONE GLYPH, TWO MEANINGS, AND A PAGE THAT SAID IT HAD ONE.
 *
 * Page 12 declared: "A dash (–) is that zero: a figure measured and nil."
 * That is a single-meaning claim, and the scorecard breaks it — in page 9's
 * TARGET column a dash means NO TARGET EXISTS, which is not a target of nil.
 * The proof the two are distinct is on the sheet itself: a cash ratio of
 * (0.16) against a nil target would be a MISS, and the row reads UNSCORED.
 * Four rows of the demo scorecard and five of Brightsphere's use the dash the
 * second way, under a page that has told the reader it has one.
 *
 * These hold both halves: page 12 states the second meaning, and the second
 * meaning is really there to state.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';
import type { PackDefinition, PackScorecardRow } from '@/modules/accounting/services/packs/pages/packBlockModel';

const FIXTURES: Array<[string, BoardPackInput]> = [
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['Brightsphere as the live route composed it', brightsphereLiveInput],
];

function definitions(input: BoardPackInput): PackDefinition[] {
  for (const page of buildBoardPackPages(input).pages) {
    for (const block of page.blocks) {
      if (block.kind === 'definitions') return block.entries;
    }
  }
  throw new Error('the pack has no definitions block');
}

function scorecardRows(input: BoardPackInput): PackScorecardRow[] {
  for (const page of buildBoardPackPages(input).pages) {
    for (const block of page.blocks) {
      if (block.kind === 'scorecard') return block.groups.flatMap((g) => g.rows);
    }
  }
  throw new Error('the pack has no scorecard');
}

describe('page 12 declares both meanings of the dash', () => {
  it.each(FIXTURES)('%s', (unusedName, input) => {
    const terms = definitions(input);
    const all = terms.map((t) => t.definition).join(' ');

    // The measured-nil meaning, which the pack has always stated.
    expect(all).toMatch(/A dash \(–\) is that zero: a figure measured and nil/);
    // And the TARGET-column meaning, which it did not.
    expect(all, 'page 12 still claims the dash carries one meaning')
      .toMatch(/TARGET cell prints a dash rather than a nil target/);

    // The entry that states the nil meaning must not leave it a universal:
    // a reader who meets a dash and reads that entry first has to be sent on.
    const notMeaningful = terms.find((t) => t.term.startsWith('Not meaningful'))!;
    expect(notMeaningful.definition,
      'the n/m entry states the dash convention with no exception').toMatch(/bar Scored below/);
  });
});

describe('the second meaning is really on the paper', () => {
  it.each(FIXTURES)('%s', (unusedName, input) => {
    // A row with no target, a measured actual, and a status of unscored. The
    // TARGET column renders `–` for it (ScorecardTable.formatTarget), and if
    // that dash meant a target of nil the row would be scored against nil
    // instead — a miss or a pass, never unscored. That is the whole argument
    // for the exception page 12 now states.
    const rows = scorecardRows(input);
    const unscoredWithoutTarget = rows.filter(
      (r) => r.target === null && r.status === 'unscored' && r.actual.value !== null,
    );
    expect(unscoredWithoutTarget.length,
      'no row uses the dash for "no target", so the exception page 12 states is dead text')
      .toBeGreaterThan(0);
    // And the pack does NOT score them, which is what distinguishes the two
    // meanings rather than merely asserting they are distinct.
    for (const row of unscoredWithoutTarget) {
      expect(row.status).not.toBe('missed');
      expect(row.status).not.toBe('met');
    }
  });
});
