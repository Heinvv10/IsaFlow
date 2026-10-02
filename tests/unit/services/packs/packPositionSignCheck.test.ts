/**
 * THE SIGN CHECK COVERS WHAT THE SHEET STATES, NOT WHAT IT TABULATES.
 *
 * Page 7 heads a block "Balances below zero" and names the rows of its own
 * table. Brightsphere's trade receivables of (330) are printed at the foot of
 * that same sheet — `tradeBalancesFootnote` puts them there, because three
 * ratios in this pack are taken on balances no row shows — and they went
 * unremarked under a block whose whole subject is figures the wrong side of
 * zero. An asset in net credit is the same question wherever the sheet prints
 * it.
 *
 * Read off the composed page, both companies: every negative asset or
 * liability the sheet states, tabulated or memorandum, is named in the block.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const HEADING = 'Balances below zero';

function positionSheet(input: BoardPackInput): { block: string; footnotes: string } {
  const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Balance sheet');
  expect(page, 'this pack has no balance sheet').toBeDefined();
  const block = page!.blocks
    .filter((b) => b.kind === 'disclosure' && b.disclosure.heading === HEADING)
    .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []))
    .join(' ');
  return { block, footnotes: page!.footnotes.map((f) => f.text).join(' ') };
}

const COMPANIES: Record<string, BoardPackInput> = {
  'the demo company': liveDemoShortPanelsInput,
  Brightsphere: brightsphereLiveInput,
};

describe('page 7 names every balance it states that is below zero', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`covers the memorandum balances on ${company}`, () => {
      const { block, footnotes } = positionSheet(input);
      const memorandum: Array<[string, number]> = [
        ['Trade receivables', input.set.current.accountsReceivable],
        ['Trade payables', input.set.current.accountsPayable],
      ];
      for (const [label, amount] of memorandum) {
        if (amount >= 0) continue;
        // The sheet has to be PRINTING it before the block can be blamed for
        // not naming it — the memorandum footnote is what puts it there.
        expect(footnotes.toLowerCase(), `${label} is not stated on this sheet at all`)
          .toContain(label.toLowerCase());
        expect(
          block.toLowerCase(),
          `${label} is ${amount} and the sheet's "${HEADING}" block does not name it: ${block}`,
        ).toContain(label.toLowerCase());
      }
    });
  }

  it('is not vacuous — one company really does carry a negative memorandum balance', () => {
    const negatives = Object.entries(COMPANIES).filter(([, input]) =>
      input.set.current.accountsReceivable < 0 || input.set.current.accountsPayable < 0);
    expect(negatives.map(([name]) => name), 'no fixture has one, so the check above proves nothing')
      .not.toEqual([]);
  });

  it('says nothing about a balance that is not below zero', () => {
    // The mirror case: a guard that names every memorandum line would satisfy
    // the test above and print a sign warning about a healthy debtor book.
    const { block } = positionSheet(liveDemoShortPanelsInput);
    if (liveDemoShortPanelsInput.set.current.accountsReceivable >= 0) {
      expect(block.toLowerCase()).not.toContain('trade receivables');
    }
    if (liveDemoShortPanelsInput.set.current.accountsPayable >= 0) {
      expect(block.toLowerCase()).not.toContain('trade payables');
    }
  });
});
