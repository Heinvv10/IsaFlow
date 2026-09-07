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
import { brightsphereInput, brightsphereLiveInput, demoInput } from './fixtures/boardPackInputs';
import {
  liveDemoBridgeInput,
  liveDemoInput,
  liveDemoRenderedInput,
  millionsCashInput,
} from './fixtures/liveDemoBoardPack';

const FIXTURES: [string, BoardPackInput][] = [
  ['the live demo company as it renders', liveDemoRenderedInput],
  // Its own EBITDA bridge, which does not add as printed — the sheet-12 note
  // that costs the glossary 7.4mm. See `liveDemoBridgeInput`.
  ['the live demo company whose EBITDA bridge rounds', liveDemoBridgeInput],
  ['the live demo company', liveDemoInput],
  ['the demo company', demoInput],
  ['Brightsphere', brightsphereInput],
  // The live tenant's own sheet 6, which refused to compose at all rather
  // than apologising — see `brightsphereLiveInput`.
  ['Brightsphere as the live route composed it', brightsphereLiveInput],
  ['cash in the millions', millionsCashInput],
];

/**
 * THE SHEETS THAT DO APOLOGISE, SINCE THE RULER WAS CORRECTED — a list, not
 * an exemption.
 *
 * Until task 36 this was `[]` for every fixture, and that was true because
 * `packTextMetrics`'s em table reads the pack's own prose 7 to 12 per cent
 * SHORT and `WIDTH_SAFETY` was set at 1.08, inside that error. Pages were
 * fitting on paper they did not have; one live page — Brightsphere's cash
 * sheet — was already budgeted 234.7mm against 238.0mm laid out, and the
 * twelve-sheet guarantee rested on the fixtures rather than on the model.
 *
 * `WIDTH_SAFETY` is now 1.12, above the worst of the 344 strings these
 * fixtures print, measured in Chromium in the real face. A factor set above
 * the worst string over-charges the average one by about seven per cent,
 * which tips roughly one line in fifteen — so four pages that were fitting by
 * the model's optimism no longer fit, and hand prose back.
 *
 * WHAT THAT COSTS A READER, page by page, is a content decision and it is
 * open: sheet 3 of the live Brightsphere pack loses the note stating the
 * scale its figures are in AND the note saying its last month is a stub;
 * sheet 5 loses the rounding footnote and the window note on six fixtures;
 * sheet 12 loses the colour key; sheet 10 loses one panel note. Task 36's fix
 * report carries the list and the millimetres. None of these pages has a
 * chart rung left to step down — sheet 5 has no chart at all — so the answer
 * is shorter prose on those four sheets, and choosing which sentence goes is
 * not a decision this file may take by leaving the ruler short.
 *
 * IT IS PINNED PER FIXTURE RATHER THAN WAIVED. A page joining this list
 * silently is the regression, and every entry leaving it is the fix.
 */
const APOLOGISES: Record<string, string[]> = {
  'the live demo company as it renders': ['10 Trends'],
  'the live demo company whose EBITDA bridge rounds': ['10 Trends'],
  'the live demo company': ['5 Group results'],
  'the demo company': ['3 Highlights'],
  Brightsphere: [],
  'Brightsphere as the live route composed it': [
    '3 Highlights', '5 Group results', '12 Basis of preparation',
  ],
  'cash in the millions': ['5 Group results'],
};

describe('no sheet apologises for its own layout', () => {
  it.each(FIXTURES)('%s', (name, input) => {
    const doc = buildBoardPackPages(input);
    const apologised = doc.pages
      .filter((p) => p.footnotes.some((f) => f.text.startsWith(OMISSION_MARK)))
      .map((p) => `${p.number} ${p.navLabel}`);
    expect(apologised, 'a sheet told the board its layout dropped prose').toEqual(APOLOGISES[name] ?? []);
  });

  // NOT VACUOUS, AND IN THE DIRECTION THAT MATTERS: the table above records a
  // cost that is meant to be paid off. When the four sheets are shortened it
  // empties, this goes red, and whoever shortened them deletes it.
  it('still has sheets to hand back', () => {
    expect(Object.values(APOLOGISES).flat().length).toBeGreaterThan(0);
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
