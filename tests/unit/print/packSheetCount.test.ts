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
import { buildMattersBlock } from '@/modules/accounting/services/packs/pages/packMattersPage';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { selectPrintedMatters } from '@/modules/accounting/services/packs/pages/packMattersPrinted';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import { fitPageToBox, fitPageReport, OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

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
   * NO PAGE RUNS PAST ITS BOX. On the paper, on every fixture.
   *
   * The sheet count alone cannot say this, and that is not a theoretical gap:
   * the render that shipped thirteen sheets had a page 19mm past a 168mm
   * landscape box, and the harness reported twelve because it measured that
   * page at the PORTRAIT width. A page 0.5mm over is one Chromium rounding
   * away from a second sheet on a different machine, so the assertion is
   * against the box rather than against the count that follows from it.
   */
  it('lays every page inside the box its sheet gives it', async () => {
    for (const [name, input] of Object.entries(FIXTURES)) {
      const document = buildBoardPackPages(input);
      const printed = await printBoardPack(document, browser);
      // 0.2mm, not zero: `min-height: 255mm` reads back as 255.1 through the
      // pixel conversion on every page that fits.
      const over = printed.heights.filter((h) => h.overMm > 0.2);
      expect(over.map((h) => `${h.id}: ${h.mm}mm in a ${h.boxMm}mm box`), `${name}: pages past their box`)
        .toEqual([]);
    }
  }, 300_000);

  /**
   * THE COMPOSER'S OWN RULER IS NEVER SHORT.
   *
   * `packPageMetrics` is what makes overflow impossible by construction: the
   * composer measures a page before it is printed and trims it to fit. That
   * is only worth anything while the measurement is CONSERVATIVE — a model
   * that under-reads a block by 5mm passes a page that then takes a
   * thirteenth sheet, which is exactly the failure the model replaced.
   *
   * So the contract is asserted in the direction that matters, page by page,
   * against Chromium's own layout: the estimate may be generous and may never
   * be short.
   *
   * AND IT IS CHECKED IN THE OTHER DIRECTION TOO, because a model answering
   * 10 000mm to everything would satisfy the first half and trim every page
   * to nothing. Two bounds, and neither is a page count:
   *
   *   - the over-estimate on a page whose prose the budget can take is under
   *     20mm, about four notes. Beyond that the trimmer is paying for the
   *     model's own slack out of the reader's document. The matters page is
   *     exempt and stated so: its budget is spent BEFORE the page is built,
   *     so looseness there costs table rows, and the page prints how many and
   *     what they come to.
   *   - no fixture abridges a disclosure the pack is REQUIRED to make. That
   *     lever exists and is reachable; a fixture that reaches it means the
   *     model's slack is being paid for out of a statutory disclosure, which
   *     is a design failure and not a tight page.
   */
  it('never estimates a page shorter than the browser lays it out', async () => {
    const slack: number[] = [];
    for (const [name, input] of Object.entries(FIXTURES)) {
      const document = buildBoardPackPages(input);
      const printed = await printBoardPack(document, browser);
      for (const [index, page] of document.pages.entries()) {
        // Pages 1 and 2 are the cover and the contents: their layout is not a
        // block list and `PackCoverV2`/`PackContents` size them themselves.
        if (!isContentPage(page.number)) continue;
        const measured = printed.heights[index]!;
        const estimate = pageMm(page);
        const matters = page.blocks.some((b) => b.kind === 'matters');
        expect(
          Math.round(estimate * 10) / 10,
          `${name} page ${page.number}: the composer budgeted ${estimate.toFixed(1)}mm and the `
            + `browser laid out ${measured.contentMm}mm. An estimate below the paper is what puts `
            + 'a page on a second sheet.',
        ).toBeGreaterThanOrEqual(measured.contentMm);
        if (!matters) slack.push(estimate - measured.contentMm);
      }
    }
    expect(slack.length, 'no page was measured').toBeGreaterThan(60);
    const worst = Math.max(...slack);
    expect(worst, `the model over-estimates a page by ${worst.toFixed(1)}mm`).toBeLessThan(20);

    for (const [name, input] of Object.entries(FIXTURES)) {
      for (const page of buildBoardPackPages(input).pages) {
        const said = page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
        if (said === undefined) continue;
        expect(
          said.text,
          `${name} page ${page.number} paid for the budget out of a required disclosure`,
        ).not.toContain('required to make');
      }
    }
  }, 300_000);

  /**
   * AND THE ASSERTION ABOVE GOES RED WHEN A BLOCK IS LET OVERFLOW.
   *
   * A guard that has never failed is a guard nobody has checked. This puts
   * ten notes of real prose on the scorecard page WITHOUT the composer's fit
   * — the same shape as the debtor-days footnote that took sheet 10 — prints
   * it, and requires the paper to say so. Then it runs the fit over the same
   * page and requires one sheet and a disclosure.
   */
  it('spills onto a second sheet when a growable block is not budgeted', async () => {
    const document = buildBoardPackPages(liveDemoInput);
    const index = document.pages.findIndex((p) => p.navLabel === 'Scorecard');
    expect(index).toBeGreaterThan(-1);
    const scorecard = document.pages[index]!;

    const flood: PackPage = {
      ...scorecard,
      blocks: [...scorecard.blocks, {
        kind: 'disclosure',
        disclosure: {
          heading: 'Reconciliation of the measures on this page',
          notes: Array.from({ length: 10 }, (unused, i) => ({
            heading: `Measure ${i + 1}`,
            body: 'This figure is the whole reporting period, measured on the period totals; the '
              + 'trends page plots the same measure one month at a time. Different windows: the two '
              + 'will not agree, and neither is derived from the other.',
          })),
        },
      }],
    };

    const unbudgeted = { ...document, pages: document.pages.map((p, i) => (i === index ? flood : p)) };
    const spilled = await printBoardPack(unbudgeted, browser);
    expect(spilled.sheets, 'the flooded page did not spill — the probe proves nothing')
      .toBeGreaterThan(unbudgeted.pages.length);
    expect(spilled.heights[index]!.overMm).toBeGreaterThan(0.2);

    // The same page, through the composer's fit.
    const fitted = fitPageToBox(flood);
    expect(pageMm(fitted)).toBeLessThanOrEqual(pageBoxMm(fitted));
    const budgeted = { ...document, pages: document.pages.map((p, i) => (i === index ? fitted : p)) };
    const printed = await printBoardPack(budgeted, browser);
    expect(printed.sheets, sheetReport(printed.sheetText, printed.heights)).toBe(budgeted.pages.length);
    expect(printed.heights.filter((h) => h.overMm > 0.2)).toEqual([]);
    // And it SAYS what it dropped, on the sheet.
    expect(printed.sheetText[index]!.replace(/\s+/g, ' ')).toContain(OMISSION_MARK);
  }, 300_000);

  /**
   * PAGE 11'S TABLE IS BUDGETED IN THE PAPER THE PAGE HAS LEFT.
   *
   * The budget used to be a constant fitted by sweeping it against this
   * harness until a fixture spilled; it is now `remainingPageMm` of the page
   * itself. This is the same measurement in the other direction: at the
   * budget the composer computes, every matters-heavy fixture prints one
   * sheet per page — and 20mm past it, one of them does not. Without the
   * second half, "the budget fits" would be satisfied by a budget of zero.
   */
  const MATTERS_HEAVY: Array<[string, BoardPackInput]> = [
    ['live', liveDemoInput],
    ['many long null-quantum matters', manyLongNullQuantumMattersInput],
    ['many short null-quantum matters', manyShortNullQuantumMattersInput],
  ];

  function packAtBudget(input: BoardPackInput, extraMm: number) {
    const document = buildBoardPackPages(input);
    const index = document.pages.findIndex((p) => p.blocks.some((b) => b.kind === 'matters'));
    const page = document.pages[index]!;
    const budget = pageBoxMm(page) - pageMm({
      ...page,
      blocks: page.blocks.map((b) => (b.kind === 'matters' ? { kind: 'matters', matters: [], omitted: null } : b)),
    }) + extraMm;
    const block = buildMattersBlock(selectPrintedMatters(input.matters, budget), new PackFigureProvenance());
    document.pages[index] = { ...page, blocks: page.blocks.map((b) => (b.kind === 'matters' ? block : b)) };
    return document;
  }

  it("spends the matters page's own remaining paper, and no more", async () => {
    for (const [name, input] of MATTERS_HEAVY) {
      const document = packAtBudget(input, 0);
      const printed = await printBoardPack(document, browser);
      expect(printed.sheets, `${name} at its budget: ${sheetReport(printed.sheetText, printed.heights)}`)
        .toBe(document.pages.length);
    }

    const over = await Promise.all(MATTERS_HEAVY.map(async ([name, input]) => {
      const document = packAtBudget(input, 40);
      const printed = await printBoardPack(document, browser);
      return { name, spilled: printed.sheets > document.pages.length };
    }));
    expect(
      over.filter((o) => o.spilled).map((o) => o.name).length,
      'no fixture spills 40mm past its budget, so the budget is looser than the paper',
    ).toBeGreaterThan(0);
  }, 300_000);

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

  it('gives the measure to the action panel when commentary is pending', async () => {
    // R-P57's other half. Page 4's commentary column ran at 2fr and held one
    // italic line — "Commentary pending approval." — over 98.2% white, while
    // the derived action panel beside it was squeezed into a third of the
    // measure and ran the depth of the sheet.
    //
    // `.pack-narrative-columns.is-pending` sizes the placeholder to its own
    // sentence and gives the rest to the panel, and NOTHING referenced that
    // class: deleting the CSS rule and the className together left 302 unit
    // tests, 447 component tests and this file green. `thinSheets` cannot see
    // it either — it counts characters per SHEET, and a sheet that is full
    // down one side and empty down the other passes.
    //
    // So it is measured on the laid-out page, as a ratio of the two columns
    // rather than as a pixel count: the placeholder is one sentence at
    // `max-content`, the panel gets what is left, and 2fr/1fr is the mutation
    // this must go red on.
    const printed = await printBoardPack(buildBoardPackPages(brightsphereInput), browser);
    expect(brightsphereInput.commentary, 'this only means anything on a pending pack').toBeNull();

    expect(printed.pendingNarrative, 'page 4 does not carry a pending narrative').not.toBeNull();
    const { placeholderMm, panelMm } = printed.pendingNarrative!;
    expect(panelMm, `the panel has ${panelMm}mm against the placeholder's ${placeholderMm}mm`)
      .toBeGreaterThan(placeholderMm);
    // At 2fr/1fr the placeholder takes 110mm of the 174mm measure. Its own
    // sentence is about 50mm, so anything past 70mm is the old layout.
    expect(placeholderMm, 'the placeholder is sized to the column, not to its sentence')
      .toBeLessThan(70);
  }, 120_000);

  it('sets the landscape page across the whole landscape sheet', async () => {
    // The trends page was laid out at 210mm on 261mm of paper, and the sheet
    // count could not see it: `PackPagesView`'s wrapper carries
    // `max-w-[210mm]`, which is right on screen and wrong on paper, where the
    // sheet already IS the measure. Fifty-one millimetres of white down the
    // right edge, and — because a page's height is a function of its width —
    // 10 to 14mm of extra height, which is what put the live Brightsphere
    // pack on a thirteenth sheet while this harness reported twelve off the
    // same document.
    //
    // Asserted on the LAID-OUT page rather than by reading the stylesheet: a
    // test that greps CSS for `max-width: none` passes on a comment. The
    // harness restates the wrapper's own utility (see `WRAPPER_UTILITIES`) so
    // this measures the same cascade the application resolves, and deleting
    // `html.print-mode .pack-pages { max-width: none }` puts it back at 210.
    const document = buildBoardPackPages(demoInput);
    expect(document.pages.some((p) => p.orientation === 'landscape')).toBe(true);

    const printed = await printBoardPack(document, browser);
    expect(printed.landscapeWidthMm, 'no landscape page was laid out').not.toBeNull();
    expect(
      printed.landscapeWidthMm!,
      `the landscape page is set across ${printed.landscapeWidthMm}mm of a 261mm sheet`,
    ).toBeGreaterThan(255);
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
