/**
 * THE PACK IS TWELVE SHEETS OF PAPER, not twelve entries in an array.
 *
 * The whole suite asserted `doc.pages.length === 12`, and the first document
 * anyone actually printed was NINETEEN sheets: six of the twelve logical
 * pages overflowed their box and spilled onto a second sheet, and one of
 * those extra sheets carried a single italic line. 302 unit tests and 432
 * component tests were green throughout, because a page's HEIGHT is not a
 * property of the model — `pages.length` is what the pack INTENDS and the
 * sheet count is what a director receives.
 *
 * So this test prints the pack, in Chromium, at A4 with the transports' own
 * margins and the real IBM Plex faces, and counts the pages of the resulting
 * PDF. Nothing about it can be satisfied by a model that says twelve.
 *
 * THREE FIXTURES, AND THE THIRD IS THE ONE THAT MATTERS. `demoInput` and
 * `brightsphereInput` are both sparse: one healthy company, one shell. The
 * document that failed was DENSE — a prior period with no positive base, so
 * every change cell held a three-line sentence instead of a percentage, and
 * fifteen matters rows. `denseInput` carries the rejected pack's own figures,
 * so a fix is proved against the document that failed rather than against a
 * fixture that happens to lay out well.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { isContentPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import {
  brightsphereInput,
  demoInput,
  denseInput,
  noRatioPanelsInput,
} from '../services/packs/fixtures/boardPackInputs';
import {
  liveDemoInput,
  manyLongNullQuantumMattersInput,
  manyShortNullQuantumMattersInput,
} from '../services/packs/fixtures/liveDemoBoardPack';
import { buildFooterHtml, PACK_CONFIDENTIALITY } from '@/lib/pdf/printFurniture';
import { printBoardPack, type PrintedPack } from './renderPackPdf';
import { buildMattersBlock } from '@/modules/accounting/services/packs/pages/packPageBlocks';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import {
  MATTERS_LINE_CEILING,
  MATTERS_PRINTED_LINE_BUDGET,
  selectPrintedMatters,
} from '@/modules/accounting/services/packs/pages/packMattersPrinted';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';

const FIXTURES = {
  demo: demoInput,
  brightsphere: brightsphereInput,
  dense: denseInput,
  'no ratio panels': noRatioPanelsInput,
  // The one fixture shaped like the company a director actually receives a
  // pack for. Every other entry here was chosen from a rendered proof that
  // had ALREADY been laid out; this one is the live demo company as the
  // second proof printed it, at fourteen sheets, and it is the reason the
  // three above could all be green while the document was wrong.
  live: liveDemoInput,
  // THE TWO SHAPES THE MATTERS CAP DID NOT CAP. `MATTERS_PRINTED_MAX` kept
  // every null-quantum matter before it looked at the count, so these printed
  // fourteen and thirteen sheets at the commit that claimed twelve. They are
  // full fixtures rather than a unit test on the selector because the thing
  // that was wrong was the number of SHEETS, and only paper can say that.
  'many long null-quantum matters': manyLongNullQuantumMattersInput,
  'many short null-quantum matters': manyShortNullQuantumMattersInput,
} as const;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

describe('the printed board pack', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`prints ${name} on exactly one sheet per model page`, async () => {
      const document = buildBoardPackPages(input);
      const printed = await printBoardPack(document, browser);

      expect(printed.sheets, sheetReport(printed.sheetText, printed.heights))
        .toBe(document.pages.length);

      // A pack can be made to fit twelve sheets by pushing content off the
      // RIGHT edge instead of the bottom, and nothing about the sheet count
      // would notice. Clipped content is worse than a nineteen-sheet pack: it
      // is gone, with nothing on the page to say it was ever there.
      expect(printed.overflow, `${name} runs past the right edge of the paper: ${JSON.stringify(printed.overflow)}`).toEqual([]);

      // And the other direction: the 19-sheet render's tell was sheets 7, 9
      // and 18 carrying nothing but the tail of the previous page's
      // footnotes, and sheet 4 carrying one italic line. A sheet with almost
      // nothing on it is never intended. Checked on EVERY fixture, because
      // page 4's fill depends on whether commentary is approved and on how
      // many matters there are, and those differ per fixture.
      expect(thinSheets(printed.sheetText), `${name}: sheets carrying almost nothing`).toEqual([]);
    }, 120_000);
  }


  /**
   * THE FITTED CONSTANT IS RE-MEASURED, NOT DESCRIBED.
   *
   * `MATTERS_PRINTED_LINE_BUDGET`'s docblock used to say "That is 47; this is
   * 40, and the eight lines of slack" while the constant beside it was 30 —
   * the one comment a reviewer has to trust about a fitted number, wrong by a
   * third, in the direction that costs a director rows on the page. The
   * budget is now `MATTERS_LINE_CEILING` less its slack, and the CEILING is
   * what this pins: at 34 every matters-heavy fixture still prints one sheet
   * per page, and at 35 one of them does not.
   *
   * Both halves matter. Without the second, "the ceiling is 34" would be
   * satisfied by any number 34 or lower, which is exactly how a budget drifts
   * six lines below the paper and nobody notices.
   *
   * The probe re-selects the matters at the budget under test and swaps the
   * page-11 block for the one that selection builds — the production builder,
   * so the rows are the rows that page would carry. Only the table's LAYOUT
   * is being measured here, which is the only thing a budget decides.
   */
  const MATTERS_HEAVY: Array<[string, BoardPackInput]> = [
    ['live', liveDemoInput],
    ['many long null-quantum matters', manyLongNullQuantumMattersInput],
    ['many short null-quantum matters', manyShortNullQuantumMattersInput],
  ];

  function packAtBudget(input: BoardPackInput, budget: number) {
    const document = buildBoardPackPages(input);
    const block = buildMattersBlock(selectPrintedMatters(input.matters, budget), new PackFigureProvenance());
    for (const page of document.pages) {
      const index = page.blocks.findIndex((b) => b.kind === 'matters');
      if (index >= 0) page.blocks[index] = block;
    }
    return document;
  }

  it('keeps the line budget under a ceiling that is measured, not asserted', async () => {
    expect(MATTERS_PRINTED_LINE_BUDGET).toBeLessThan(MATTERS_LINE_CEILING);

    for (const [name, input] of MATTERS_HEAVY) {
      const document = packAtBudget(input, MATTERS_LINE_CEILING);
      const printed = await printBoardPack(document, browser);
      expect(printed.sheets, `${name} at the ceiling: ${sheetReport(printed.sheetText, printed.heights)}`)
        .toBe(document.pages.length);
    }

    // And one line past it is over the paper — otherwise the ceiling is just
    // the smallest number anyone happened to try.
    const over = await Promise.all(MATTERS_HEAVY.map(async ([name, input]) => {
      const document = packAtBudget(input, MATTERS_LINE_CEILING + 1);
      const printed = await printBoardPack(document, browser);
      return { name, spilled: printed.sheets > document.pages.length };
    }));
    expect(
      over.filter((o) => o.spilled).map((o) => o.name).length,
      `no fixture spills at ${MATTERS_LINE_CEILING + 1} lines, so the ceiling is lower than it claims`,
    ).toBeGreaterThan(0);
  }, 180_000);

  /**
   * EVERY CONTENT SHEET IDENTIFIES ITSELF AS THE PAGE THE CONTENTS NAMES.
   *
   * The previous round proved a title prints somewhere, using `page.title` —
   * which is a CONCLUSION by rule, "Gross margin is a negative 1348.0%,
   * carrying operating expenses of 226." Six of the ten content sheets
   * happened to open with their own name; sheets 3, 4, 6 and 10 did not, so a
   * director turning to sheet 6 from a Contents page promising "Income
   * statement" found nothing on the page saying so.
   *
   * `navLabel` is the string the Contents itself prints, so this compares the
   * page against its own index entry rather than against a second spelling.
   * Both are asserted: the page must be findable AND must still state its
   * conclusion.
   */
  it("prints every content page's NAME and its conclusion on its own sheet", async () => {
    // The pack is BUILT on message titles — `assertPageTitleIsAMessage`, the
    // rubric's first criterion ("every content page title states a conclusion
    // about this period"), and a whole task spent making the titles say
    // something. On paper not one of them appeared: `styles/print.css` hid
    // `header` to strip AppLayout's chrome, and `PackPageFrame` carries the
    // title in a `<header>`. Sheets 3 to 14 opened straight into a table or a
    // chart, and a director reading one out of order could not name it.
    //
    // Every title test in the suite read the MODEL, where the titles were
    // present and correct throughout. So this one reads the SHEET, on the
    // fixture shaped like the live company, and compares the letters only:
    // PDF text extraction breaks words apart ("ACTU AL") and no probe
    // survives it otherwise.
    const document = buildBoardPackPages(liveDemoInput);
    const printed = await printBoardPack(document, browser);
    const letters = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

    // One sheet per page is asserted above, so the sheet at a page's index IS
    // that page's sheet — no searching, which would pass on a title printed
    // on the wrong sheet.
    expect(printed.sheets).toBe(document.pages.length);
    for (const [index, page] of document.pages.entries()) {
      if (!isContentPage(page.number)) continue;
      expect(
        letters(printed.sheetText[index] ?? ''),
        `sheet ${index + 1} does not carry page ${page.number}'s title: "${page.title}"`,
      ).toContain(letters(page.title));

      // THE NAME IS ASSERTED IN THE TITLE'S POSITION, and against the whole
      // of what that position emits.
      //
      // The previous round searched the whole sheet for the label's letters.
      // Hiding the heading failed it on sheets 3, 4, 6 and 10 — the four that
      // were broken — and PASSED on 5, 7, 9 and 12, whose conclusion
      // sentences happen to contain their own nav label's letters. The fix
      // was real on all ten sheets and the guard held four of them: a test
      // that passes because its search string is a substring of unrelated
      // prose is not asserting what its name says.
      //
      // Equality, not containment, so the title slot is an ALLOW-LIST: the
      // heading emits the Contents page's own string and nothing else.
      expect(
        printed.pageNames[index],
        `sheet ${index + 1} prints nothing in its title position, or prints something other `
          + `than "${page.navLabel}" — which is what the Contents page promises at number ${page.number}`,
      ).toBe(page.navLabel);

      // And it reached the PAPER. The line above reads the laid-out DOM,
      // which cannot see a heading painted in white or printed off the edge.
      expect(
        letters(printed.sheetText[index] ?? ''),
        `sheet ${index + 1}'s title position holds "${page.navLabel}" but the sheet does not print it`,
      ).toContain(letters(page.navLabel));
    }
  }, 120_000);

  /**
   * ONE NEGATIVE CONVENTION, READ OFF THE PAPER, AND ON THE CHARACTER.
   *
   * The rendered pack printed `(1 546)`, `−1348.0%` and `-0.14` within a few
   * rows of each other on sheet 9 — an accounting bracket, a U+2212 and an
   * ASCII hyphen for one idea. Spec §7.1 criterion 8 is one number convention
   * per pack, and asserting "there is a sign" would have passed on all three.
   *
   * POSITIONAL, like every other guard in this codebase that learnt the
   * lesson: a `-` after a digit or a letter is an ISO date (`2026-09-07`), a
   * range or a hyphenated word, and matching one anywhere in a document
   * matches it in data. What is refused is a minus opening a number — the one
   * position where it is a sign — ADJACENT to the digit, because a hyphen
   * with a space after it is a dash in prose, and the matters page carries
   * "Bank Charges - 2026/01" straight out of a journal reference. The live
   * fixture is the one that carries
   * negative money, negative percentages and negative ratios at once.
   */
  it('prints negatives in brackets, with no minus sign of either kind', async () => {
    const printed = await printBoardPack(buildBoardPackPages(liveDemoInput), browser);
    for (const [index, text] of printed.sheetText.entries()) {
      const offenders = [...text.matchAll(/(?<![0-9A-Za-z])[-\u2212]\d/g)].map((m) => m[0]);
      expect(offenders, `sheet ${index + 1} prints a signed negative, not a bracket`).toEqual([]);
    }
    // And the convention is actually exercised on this pack rather than
    // vacuously satisfied by a document with no negatives in it.
    expect(printed.sheetText.some((t) => /\(\d/.test(t.replace(/\s+/g, ' ')))).toBe(true);
  }, 120_000);

  it('prints the brand band on the cover of a DRAFT pack', async () => {
    // The rendered cover measured 1 972 pixels of rgb(241,243,245) where a
    // 12mm band of brand colour belonged — white paper, to a reader, and
    // reported as zero coloured pixels. The band and the DRAFT watermark were
    // the same pseudo-element: `PackCoverV2` puts `pack-page` and
    // `pack-cover` on one element, and `[data-pack-draft] .pack-page::before`
    // outranks `.pack-cover::before`, so the band was drawn at the
    // watermark's 6% opacity, rotated, in the middle of the sheet.
    //
    // On the DRAFT fixture specifically: on a final pack the band was fine,
    // which is why it survived a review.
    const printed = await printBoardPack(buildBoardPackPages(liveDemoInput), browser);
    expect(liveDemoInput.draft, 'this only fails on a draft pack').toBe(true);
    expect(printed.coverBand).not.toBeNull();
    // AND IT SAYS SOMETHING. The band printed as a bare navy rectangle — no
    // logo, no name, no mark — at the top of the first page of a document a
    // director forwards to their bank.
    // The resolved `content`, not the attribute that feeds it: dropping the
    // `content: attr(...)` rule leaves the attribute in the markup and the
    // band empty on the paper.
    expect(printed.coverBand!.text).toBe(liveDemoInput.companyLegalName);
    expect(printed.coverBand!.content).toContain(liveDemoInput.companyLegalName);
    expect(printed.coverBand!.background).toBe('rgb(31, 78, 121)'); // the fixture's brand
    expect(printed.coverBand!.opacity).toBe(1);
    expect(printed.coverBand!.top).toBe('0px');
    expect(printed.coverBand!.heightPx).toBeGreaterThan(30); // 12mm at 96dpi
    // And it must actually be printed rather than dropped by Chromium's
    // ink-saving default, which is what washes a band out on paper.
    expect(printed.coverBand!.colorAdjust).toBe('exact');
  }, 120_000);

  it('runs the company, the pack, the period and the confidentiality mark along every sheet', async () => {
    // `buildFooterHtml` and `buildPdfMetadata` were written, reviewed and
    // merged with NO CALLER: `pdf.ts` asked for a render and never passed
    // them, so every pack printed Chromium's bare `n / m` and `pdfinfo`
    // reported no metadata at all. A document a director forwards to their
    // bank had no company name, no period and no confidentiality mark on any
    // page of it, and nothing in the suite could tell — the footer is drawn
    // by the browser into the page MARGIN, so it is not in the DOM and only
    // a printed document has it.
    const furniture = {
      companyName: 'ISAFlow Demo (Pty) Ltd',
      packLabel: 'Board Pack',
      period: '1 March 2026 to 31 August 2026',
      confidentiality: PACK_CONFIDENTIALITY,
      // The SAME flag the pack body's watermark reads. The route derives both
      // from one period status, and a footer saying DRAFT over a body saying
      // FINAL on the same sheet is the contradiction that pairing prevents —
      // so the harness must not fabricate its own answer either.
      draft: demoInput.draft,
    };
    const printed = await printBoardPack(
      buildBoardPackPages(demoInput),
      browser,
      buildFooterHtml(furniture),
    );

    for (const [index, text] of printed.sheetText.entries()) {
      const flat = text.replace(/\s+/g, ' ');
      const needles = [furniture.companyName, furniture.packLabel, furniture.period, furniture.confidentiality];
      for (const needle of needles) {
        expect(flat, `sheet ${index + 1} footer is missing "${needle}"`).toContain(needle);
      }
    }
  }, 120_000);

  it('says something about total assets below zero, as it does about equity', async () => {
    // The rendered pack printed total assets of (733) with no comment while
    // negative equity, on the same sheet, from the same balance sheet, got a
    // callout. An asset side below zero is not a state a business can be in,
    // and a page that explains the lesser anomaly and stays silent on the
    // greater one reads as though the greater one is normal.
    expect(liveDemoInput.set.current.totalAssets, 'this fixture is the negative-assets case').toBeLessThan(0);

    const printed = await printBoardPack(buildBoardPackPages(liveDemoInput), browser);
    const sheet = printed.sheetText
      .map((t) => t.replace(/\s+/g, ' '))
      .find((t) => t.includes('Negative total assets'));

    expect(sheet, 'no sheet carries the negative-assets disclosure').toBeDefined();
    expect(sheet).toContain('asset accounts carry credit balances');
    // Beside the equity callout, not instead of it.
    expect(sheet).toContain('Negative equity');
  }, 120_000);

  it("prints page 4's action panel on the sheet, filled, commentary or not", async () => {
    // R-P57. Page 4 was built as commentary-ONLY, so with nothing approved it
    // printed one italic line at 1.0% fill on a sheet of its own — and the
    // first remedy, merging it away, made the pack eleven pages for one
    // company and twelve for another. §4.A specifies a second column and it
    // was never populated. Asserted on the PRINTED sheet, and on the fixture
    // whose commentary is pending, because that is the case the panel exists
    // to carry.
    const printed = await printBoardPack(buildBoardPackPages(brightsphereInput), browser);
    const sheet = printed.sheetText
      .map((t) => t.replace(/\s+/g, ' '))
      .find((t) => t.includes('Commentary pending approval'));

    expect(sheet, 'no sheet carries the pending placeholder').toBeDefined();
    // The panel, its heading, and an item in it — not merely the heading.
    expect(sheet).toContain('For the board');
    expect(sheet).toMatch(/No matters require board attention/);
    // And the placeholder is still there beside it: filling the panel must
    // not become a way to stop saying commentary is owed.
    expect(sheet).toContain('Commentary pending approval');
  }, 120_000);

  it('prints the landscape page on ONE landscape sheet', async () => {
    // `.pack-page`'s min-height is 255mm — the PORTRAIT box. A landscape
    // sheet's box is 168mm, so page 10 was 87mm taller than the paper it was
    // printed on and spilled onto a second, blank, landscape sheet on every
    // pack ever rendered. The blank sheet was the min-height, not content.
    const document = buildBoardPackPages(demoInput);
    const landscape = document.pages.filter((p) => p.orientation === 'landscape');
    expect(landscape).toHaveLength(1);

    // Probed by a phrase only that page carries, not by its title: PDF text
    // extraction breaks words apart ("ACTU AL"), so no long probe survives —
    // and the contents page lists short nav labels, which a short probe would
    // match a second time.
    const printed = await printBoardPack(document, browser);
    const sheets = printed.sheetText.filter((t) => t.replace(/\s+/g, ' ').includes('Reading these panels'));
    expect(sheets.length, 'the trends page spans more than one sheet').toBe(1);
  }, 120_000);
});

/**
 * Sheets carrying almost nothing.
 *
 * The cover is the one deliberately sparse sheet in the pack — a company
 * name, a period and a confidentiality mark — so it is exempt. Everything
 * else on a board pack is content.
 */
function thinSheets(sheetText: string[]): Array<{ sheet: number; chars: number }> {
  return sheetText
    .map((text, i) => ({ sheet: i + 1, chars: text.replace(/\s+/g, ' ').trim().length }))
    .filter((s) => s.sheet !== 1 && s.chars < 250);
}

/**
 * What is on each sheet, for the failure message.
 *
 * A bare "expected 14 to be 12" sends the next reader to open a PDF by hand.
 * The opening words of each sheet are enough to see WHERE the extra sheets
 * came from — matching page TITLES instead does not work, because PDF text
 * extraction breaks words apart ("ACTU AL") and no probe survives it.
 */
function sheetReport(sheetText: string[], heights: PrintedPack['heights']): string {
  const lines = sheetText.map((text, i) =>
    `  sheet ${i + 1}: ${text.replace(/\s+/g, ' ').trim().slice(0, 70)}`);
  // And WHICH page box is too tall, by how much. A sheet count alone says a
  // page spilled and never says which one or by how far.
  const over = heights
    .filter((h) => h.overMm > 0.2)
    .map((h) => [
      `  ${h.id}: ${h.mm}mm in a ${h.boxMm}mm box (+${h.overMm}mm)`,
      ...h.blocks.map((b) => `      ${b.mm}mm ${b.what}`),
    ].join('\n'));
  return `${sheetText.length} sheets:\n${lines.join('\n')}\npages past their box:\n${over.join('\n') || '  none'}`;
}
