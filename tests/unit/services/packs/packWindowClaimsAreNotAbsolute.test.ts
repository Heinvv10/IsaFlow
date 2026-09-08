/**
 * "DIFFERENT WINDOWS: THE TWO WILL NOT AGREE", PRINTED ABOVE TWO NUMBERS THAT
 * DO.
 *
 * The pack says this in three places — the cash page's footnote, the trends
 * page's Period note, and the reciprocal footnote on every statement page
 * that carries a drawn panel's period figure — and it was false on three
 * sheets at once:
 *
 *   - the client cash page printed "Opening cash (267)" and, twelve lines
 *     below, a chart caption reading "fell from (267) at Oct 2025";
 *   - the client trends page asserted it of four measures whose month IS the
 *     period, because the whole year posts into one month;
 *   - the demo trends page asserted it of closing cash, where agreement is
 *     STRUCTURAL: cash is a stock, so the last point of a monthly series and
 *     the period's closing balance are the same balance on the same date.
 *
 * The third is the one that settles the word. The first two are ledgers; that
 * one is arithmetic, and no pack can ever print those two figures
 * differently. "Need not agree" says everything the pack meant and is true on
 * every sheet.
 *
 * This holds the claim to what the pack can support, and it holds the
 * counter-example that makes the old wording false, so a future round cannot
 * restore "will" without being shown the pair of numbers that disproves it.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput, demoInput } from './fixtures/boardPackInputs';
import { liveDemoInput, liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';

const FIXTURES: Array<[string, BoardPackInput]> = [
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['the live demo company', liveDemoInput],
  ['the demo company', demoInput],
  ['Brightsphere as the live route composed it', brightsphereLiveInput],
];

/** Every sentence the pack prints as prose: disclosure notes and footnotes,
 *  on every sheet. A claim about how to read two figures can live in either. */
function allProse(input: BoardPackInput): string {
  const parts: string[] = [];
  for (const page of buildBoardPackPages(input).pages) {
    for (const block of page.blocks) {
      if (block.kind === 'disclosure') parts.push(...block.disclosure.notes.map((n) => n.body));
    }
    parts.push(...page.footnotes.map((f) => f.text));
  }
  return parts.join('\n');
}

describe('the pack never claims two figures CANNOT agree', () => {
  it.each(FIXTURES)('%s', (unusedName, input) => {
    const prose = allProse(input);
    // The idea is kept — the pack must still tell a reader the windows differ.
    expect(prose, 'the month-versus-period reconciliation went missing entirely')
      .toMatch(/Different windows/);
    // What may not survive is the universal.
    expect(prose).not.toMatch(/will not agree/);
    expect(prose).not.toMatch(/cannot agree/);
    expect(prose).not.toMatch(/can never agree/);
    expect(prose).toMatch(/need not agree/);
  });
});

describe('the counter-example the wording has to survive', () => {
  it('closing cash is one balance, so the month and the period cannot differ', () => {
    // Cash is a STOCK. The trends page's cash panel ends on the reporting
    // date and the cash page's closing cash is the balance on the reporting
    // date, so they are the same number by construction on every pack — which
    // is what makes "will not agree" false rather than merely unlucky.
    const last = liveDemoRenderedInput.trend[liveDemoRenderedInput.trend.length - 1]!;
    expect(last.cash).toBe(liveDemoRenderedInput.set.current.cash);
  });

  it('and the client pack states its opening cash twice, in words, on one sheet', () => {
    // The cash page's table opens at the period start and its chart caption
    // opens at the first month of the twelve-month series. On this ledger
    // those are the same balance, printed twelve lines apart, under the
    // footnote that used to say they could not be.
    const first = brightsphereLiveInput.trend[0]!;
    const prose = allProse(brightsphereLiveInput);
    expect(prose).toMatch(/Different windows: the two need not agree/);
    expect(first.label).toBe('Oct 2025');
  });
});
