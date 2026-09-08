/**
 * A STATEMENT ABOUT A LIST IS NOT A MEMBER OF IT.
 *
 * Page 4's action panel set "1 further matter follows on the matters page."
 * and "27 further matters are not printed in this pack" as list items beside
 * three decisions, in the same type — so a director scanning a panel of
 * things to decide counts five, and two of them are counts.
 *
 * They are carried separately now and set below the list at footnote size.
 * The INTEGRITY gate reads both halves: it refuses a panel whose remainder
 * disagrees with the matters page, and reading only the list made it refuse
 * every pack that discloses an omission.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const COMPANIES: Record<string, BoardPackInput> = {
  'the demo company': liveDemoShortPanelsInput,
  Brightsphere: brightsphereLiveInput,
};

function panel(input: BoardPackInput): { items: string[]; tail: string[] } {
  for (const page of buildBoardPackPages(input).pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'narrative' || block.boardActions === undefined) continue;
      if (block.boardActions.length === 0) continue;
      return { items: block.boardActions, tail: block.boardActionsTail ?? [] };
    }
  }
  throw new Error('no action panel in this pack');
}

const COUNT = /^\d+ further matter/;

describe('the action panel lists decisions and counts the rest below', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`keeps every count out of the list on ${company}`, () => {
      const { items } = panel(input);
      expect(items.length, 'this pack lists no matters at all').toBeGreaterThan(0);
      for (const item of items) {
        expect(item, `a count set as a decision: ${item}`).not.toMatch(COUNT);
      }
    });

    it(`puts nothing but counts in the tail on ${company}`, () => {
      // The mirror: moving a MATTER out of the list would satisfy the test
      // above and quietly demote a decision to a footnote.
      for (const line of panel(input).tail) {
        expect(line, `a matter set below the list: ${line}`).toMatch(COUNT);
      }
    });
  }

  it('is not vacuous — a pack with a remainder states it below the list', () => {
    // The demo prints five matters of twenty-nine and names three on the
    // panel, so it has both kinds of remainder to state. Brightsphere's
    // fixture prints everything it has and states none, which is the other
    // half of the rule and why the tail is allowed to be empty.
    const demo = panel(liveDemoShortPanelsInput);
    expect(demo.tail.length, 'the demo states no remainder, so the split is untested')
      .toBeGreaterThan(0);
    expect(demo.tail.join(' ')).toMatch(/not printed in this pack/);
  });
});
