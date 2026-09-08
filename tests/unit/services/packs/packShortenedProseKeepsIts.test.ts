/**
 * THE FOUR SHEETS THE CORRECTED RULER COST, AND WHAT THEY PRINT NOW.
 *
 * `WIDTH_SAFETY` went from 1.08 — inside the em table's own 7-12% error — to
 * 1.12, above the worst of the 344 strings the print fixtures put on paper
 * (task 36). Four sheets had been fitting on paper they did not have, and
 * handed prose back: sheet 3 dropped the Scale note AND the part-month note,
 * sheet 5 dropped the rounding footnote AND the window note — the second note
 * of a disclosure this pack is REQUIRED to make — sheet 10 dropped the
 * month-versus-period note, and sheet 11 printed one matter fewer, moving a
 * quantified exposure out of the table and into the unprinted tail.
 *
 * The ruler was not touched. The prose was shortened instead (task 37), and
 * this file holds the four sheets to what they must still say. It is the
 * complement of `packPagesKeepTheirProse.test.ts`: that one asserts no sheet
 * writes an omission footnote, which is the SYMPTOM; this asserts the specific
 * sentences and the specific row are on the paper, which is what a director
 * loses when they are not.
 *
 * MUTATION-PROOF IN THE ONE DIRECTION THAT MATTERS: lengthen any of the five
 * shortened notes back towards what it said and the sheet goes over its box,
 * the trimmer takes the note, and the matching assertion below goes red. Each
 * one was reverted individually and watched fail — see task 37's fix report.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput, demoInput } from './fixtures/boardPackInputs';
import {
  liveDemoBridgeInput,
  liveDemoInput,
  liveDemoRenderedInput,
  millionsCashInput,
} from './fixtures/liveDemoBoardPack';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

/** The fixtures that reached a trimmer at 1.12. Brightsphere's small pack and
 *  the dense one never did, so they prove nothing here. */
const FIXTURES: [string, BoardPackInput][] = [
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['the live demo company whose EBITDA bridge rounds', liveDemoBridgeInput],
  ['the live demo company', liveDemoInput],
  ['the demo company', demoInput],
  ['Brightsphere as the live route composed it', brightsphereLiveInput],
  ['cash in the millions', millionsCashInput],
];

const pageNamed = (pages: PackPage[], navLabel: string): PackPage =>
  pages.find((p) => p.navLabel === navLabel)!;

/** The notes of one disclosure block, by its heading, or null where the page
 *  does not carry that block at all. */
function notesUnder(page: PackPage, heading: string): Array<{ heading: string; body: string }> | null {
  const block = page.blocks.find((b) => b.kind === 'disclosure' && b.disclosure.heading === heading);
  return block === undefined || block.kind !== 'disclosure' ? null : block.disclosure.notes;
}

describe('sheet 5 keeps both notes of a disclosure it is required to make', () => {
  it.each(FIXTURES)('%s', (unused, input) => {
    const page = pageNamed(buildBoardPackPages(input).pages, 'Group results');
    const notes = notesUnder(page, 'Reading this table');
    // A pack with no monthly series carries "No monthly series" instead, and
    // has no window to state.
    if (notes === null) return;
    expect(notes.map((n) => n.heading), 'the required disclosure was abridged')
      .toEqual(['The columns', 'The window']);
    // THE WINDOW NOTE'S OWN CONTENT, not just its heading: it says what the
    // table covers and where the period's own totals are.
    const window = notes[1]!.body;
    // "the window page 10 DRAWS FROM", not "the series page 10 draws": two
    // of the live demo's six panels plot three periods of the twelve, so the
    // stronger claim was false on that pack and true on Brightsphere. See
    // `packShortenedPanels.test.ts`.
    expect(window).toMatch(/This table covers .+ the window page 10 draws from/);
    expect(window).toMatch(/income statement overleaf carries the reporting period's own totals/);
    // AND THE ROUNDING FOOTNOTE, which was the first thing the trimmer took.
    expect(page.footnotes.some((f) => /rounded to the nearest/.test(f.text)),
      'sheet 5 dropped the rounding footnote').toBe(true);
  });

  /**
   * AND WHERE THE SERIES ENDS MID-MONTH IT SAYS SO, IN THAT NOTE.
   *
   * The part-month clause rides on the window note rather than in a block of
   * its own — page 5 has the paper for a clause and not for a block — so the
   * note being trimmed took the stub statement with it.
   */
  it('states the stub month on the packs whose series ends on one', () => {
    for (const input of [liveDemoRenderedInput, brightsphereLiveInput]) {
      const page = pageNamed(buildBoardPackPages(input).pages, 'Group results');
      const window = notesUnder(page, 'Reading this table')![1]!.body;
      expect(window, 'the part-month clause is not on sheet 5')
        .toMatch(/is a part month: it covers \d+ of its \d+ days/);
    }
  });
});

describe('sheet 10 keeps the month-versus-period note', () => {
  it.each(FIXTURES)('%s', (unused, input) => {
    const page = pageNamed(buildBoardPackPages(input).pages, 'Trends');
    const notes = notesUnder(page, 'Reading these panels');
    if (notes === null) return;
    const period = notes.find((n) => n.heading === 'Period');
    expect(period, 'sheet 10 dropped the note that reconciles its window with the statements')
      .toBeDefined();
    expect(period!.body).toMatch(/Each panel plots one MONTH/);
    expect(period!.body).toMatch(/Different windows: the two need not agree/);
    // AND THE SCALE NOTE BESIDE IT, which is where the shared y-scale is
    // explained and the only place the panels off it are listed.
    expect(notes.some((n) => n.heading === 'Scale'), 'sheet 10 dropped the scale note').toBe(true);
  });
});

/**
 * SHEET 11, WHERE THE COST WAS NOT A SENTENCE BUT A ROW.
 *
 * Page 11's prose is not trimmed by `fitPageToBox` at all — it is subtracted
 * from the table's budget BEFORE the selection runs (`mattersBudgetMm`), so a
 * line of it is a matter that does not print. At four lines the "What was
 * checked" block took the live demo pack from seven printed matters to six,
 * moving a quantified exposure out of the table a director reads and into the
 * "further matters are not printed" tail.
 */
describe('sheet 11 spends its prose budget on matters', () => {
  it('prints the row the support block was costing it', () => {
    const doc = buildBoardPackPages(liveDemoRenderedInput);
    const page = pageNamed(doc.pages, 'Matters for the board');
    const table = page.blocks.find((b) => b.kind === 'matters')!;
    // SIX, AND THE SEVENTH WAS SPENT DELIBERATELY. This asserted seven, and
    // the row that has gone bought the lettered reason under the QUANTUM
    // column's `n/m` — the one not-meaningful figure in the pack carrying
    // none, on both companies. The note is reserved in `mattersBudgetMm`
    // rather than discovered by `fitPageToBox`, which is the difference
    // between a page that prints one fewer matter and a page that apologises
    // for its own layout; charging for it without reserving it dropped the
    // "What was checked" disclosure instead.
    //
    // It could not be paid for in prose: the reserve is a whole line of the
    // notes list either way, and shortening the reason itself does not bring
    // the row back (measured, both a 46-character and a 95-character
    // wording). What is still true is the rule this test exists for — prose
    // on this page is paid for in matters rows, so a fourth line of the
    // support block would cost a SECOND one.
    //
    // AND FIVE IS THE SECOND ONE, SPENT DELIBERATELY TOO. The demo pack's
    // R10.7m subledger-to-control gap reaches this page now: sheet 9 prints
    // `Debtor days · 213 · target 30 · MISSED` in red against a base sheet 4
    // disowns, and a red MISS is a printed judgement. A structurally
    // identical gap reached Brightsphere's matters page fully attributed
    // while the demo's appeared once as a parenthetical. The gap is a larger
    // fact than a sixth matter, and the tail still says what it withheld.
    expect(table.kind === 'matters' ? table.matters.length : 0,
      'sheet 11 prints fewer matters than its paper allows').toBe(5);
    expect(table.kind === 'matters' ? table.omitted?.count ?? 0 : 0).toBe(24);
    // AND THE MATTER THAT CAME BACK CARRIES A RAND AMOUNT — the point of the
    // row is that real exposure is on the page rather than summarised in the
    // tail.
    const last = table.kind === 'matters' ? table.matters[6]! : null;
    expect(last?.quantum.value, 'the row that came back states no amount').not.toBeNull();
  });

  it('still states both facts the merged note carries', () => {
    const page = pageNamed(buildBoardPackPages(liveDemoRenderedInput).pages, 'Matters for the board');
    const body = notesUnder(page, 'What was checked')!.map((n) => n.body).join(' ');
    // The four sources, the no-silent-omission guarantee, and why the
    // Movement column reads untracked. Merging the notes may not lose any of
    // the three.
    expect(body).toMatch(/Aged debtor concentration/);
    expect(body).toMatch(/unreconciled bank items/);
    expect(body).toMatch(/unusual journals/);
    expect(body).toMatch(/overdue statutory filings/);
    expect(body).toMatch(/named as a matter, never dropped/);
    // AND THE FIFTH CHECK, which is what this note was missing: the
    // net-credit month is the largest matter in both packs and no listed
    // source produced it.
    expect(body).toMatch(/months whose expenses are a net credit/);
    // "No prior pack is stored, so movement is untracked" is GONE from here
    // deliberately, and is not a lost fact: the Movement line prints it
    // directly below this block on the same sheet ("Not tracked — no prior
    // board pack is stored to compare against."). One fact twice on one page
    // is what paid for the fifth source on a sheet budgeted in matters rows.
    expect(body).not.toMatch(/movement is untracked/);
  });
});

/**
 * AND SHEET 3'S TWO NOTES, WHICH ARE HELD IN
 * `packPresentationConventions.test.ts` — the part-month sentence and the
 * scale statement, on both live packs. Not duplicated here.
 */
