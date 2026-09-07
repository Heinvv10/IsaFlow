/**
 * A BOARD PACK DOES NOT TELL A BOARD THAT ITS LAYOUT DROPPED THE EXPLANATION.
 *
 * The rendered demo pack printed, at the foot of two sheets:
 *
 *   Not printed on this page: 1 explanatory note, from “Scoring basis”.
 *   Not printed on this page: 2 explanatory notes, from “Reading these panels”.
 *
 * The scorecard's was a POINTER to where MISSED and NOT MEANINGFUL are
 * defined — and it pointed at the basis sheet, which prints those definitions
 * whether or not the pointer survives. The trends page's two were the notes
 * its own "1.1% of the shared range" claims are checked against, so the sheet
 * kept the claim and dropped the means of checking it. Brightsphere prints
 * both sections in full on the identical template, so neither was a design
 * that cannot fit — both were pages spending their paper badly.
 *
 * `fitPageToBox` is not the defect and the footnote it writes is not either:
 * a page that has to abridge should say so. What must not happen is a page
 * REACHING for it in the ordinary case. This holds the ordinary case.
 *
 * Sheet 11's "N further matters are not printed" is a different sentence and
 * is deliberately not covered here: it quantifies withheld DATA, foots against
 * the printed rows, and is proper disclosure rather than a layout apology.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import { brightsphereInput, demoInput } from './fixtures/boardPackInputs';
import {
  liveDemoInput,
  liveDemoRenderedInput,
  millionsCashInput,
} from './fixtures/liveDemoBoardPack';

const FIXTURES: [string, BoardPackInput][] = [
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['the live demo company', liveDemoInput],
  ['the demo company', demoInput],
  ['Brightsphere', brightsphereInput],
  ['cash in the millions', millionsCashInput],
];

describe('no sheet apologises for its own layout', () => {
  it.each(FIXTURES)('%s', (unused, input) => {
    const doc = buildBoardPackPages(input);
    const apologised = doc.pages
      .filter((p) => p.footnotes.some((f) => f.text.startsWith(OMISSION_MARK)))
      .map((p) => `${p.number} ${p.navLabel}`);
    expect(apologised, 'a sheet told the board its layout dropped prose').toEqual([]);
  });

  /**
   * And every footnote on a sheet has its own number. The trimmer leaves gaps
   * — a surviving footnote keeps the number the table's superscript points at
   * — so a page that numbered its apology off the COUNT issued a second 3.
   */
  it.each(FIXTURES)('%s numbers every footnote once', (unused, input) => {
    for (const p of buildBoardPackPages(input).pages) {
      const numbers = p.footnotes.map((f) => f.number);
      expect(new Set(numbers).size, `page ${p.number} (${p.navLabel}) repeats a footnote number`)
        .toBe(numbers.length);
    }
  });
});

describe('the scorecard says where its status words are defined', () => {
  it('keeps the pointer to the sheet that defines them, and that sheet defines them', () => {
    const doc = buildBoardPackPages(liveDemoRenderedInput);
    const scorecard = doc.pages.find((p) => p.navLabel === 'Scorecard')!;
    const basis = doc.pages.find((p) => p.navLabel === 'Basis of preparation')!;

    // The pointer is the whole of what this sheet says about its own terms —
    // "Targets" and "Not meaningful" were moved to the basis sheet — so the
    // sheet losing it leaves a column of MISSED and NOT MEANINGFUL defined
    // nowhere a reader is sent.
    const pointer = scorecard.blocks.flatMap((b) => (b.kind === 'disclosure'
      ? b.disclosure.notes.map((n) => n.body)
      : []));
    expect(pointer.some((t) => /basis page/i.test(t)),
      'the scorecard sheet says nowhere where its terms are defined').toBe(true);

    // And the sheet it points at really does carry them.
    const defined = basis.blocks.flatMap((b) => (b.kind === 'definitions'
      ? b.entries.map((e) => `${e.term} ${e.definition}`)
      : []));
    expect(defined.some((t) => /not meaningful/i.test(t)),
      'the scorecard points at a sheet that does not define its status words').toBe(true);
  });
});
