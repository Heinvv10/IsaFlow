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
import {
  brightsphereInput,
  demoInput,
  denseInput,
  noRatioPanelsInput,
} from '../services/packs/fixtures/boardPackInputs';
import { buildFooterHtml, PACK_CONFIDENTIALITY } from '@/lib/pdf/printFurniture';
import { printBoardPack } from './renderPackPdf';

const FIXTURES = {
  demo: demoInput,
  brightsphere: brightsphereInput,
  dense: denseInput,
  'no ratio panels': noRatioPanelsInput,
} as const;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

describe('the printed board pack', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`prints ${name} on exactly one sheet per model page`, async () => {
      const document = buildBoardPackPages(input);
      const printed = await printBoardPack(document, browser);

      expect(printed.sheets, sheetReport(document.pages.map((p) => p.title), printed.sheetText))
        .toBe(document.pages.length);

      // A pack can be made to fit twelve sheets by pushing content off the
      // RIGHT edge instead of the bottom, and nothing about the sheet count
      // would notice. Clipped content is worse than a nineteen-sheet pack: it
      // is gone, with nothing on the page to say it was ever there.
      expect(printed.overflow, `${name} runs past the right edge of the paper`).toEqual([]);
    }, 120_000);
  }

  it('leaves no sheet blank — an empty sheet is a page that overflowed', async () => {
    // The 19-sheet render's tell: sheets 7, 9 and 18 carried nothing but the
    // tail of the previous page's footnotes, and sheet 4 carried one italic
    // line. A sheet with almost nothing on it is never intended.
    const printed = await printBoardPack(buildBoardPackPages(denseInput), browser);
    const thin = printed.sheetText
      .map((text, i) => ({ sheet: i + 1, chars: text.replace(/\s+/g, ' ').trim().length }))
      // The cover is the one deliberately sparse sheet in the pack: a company
      // name, a period and a confidentiality mark. Everything else is content.
      .filter((s) => s.sheet !== 1 && s.chars < 200);
    expect(thin, 'sheets carrying almost nothing').toEqual([]);
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
 * What is on each sheet, for the failure message.
 *
 * A bare "expected 14 to be 12" sends the next reader to open a PDF by hand.
 * The opening words of each sheet are enough to see WHERE the extra sheets
 * came from — matching page TITLES instead does not work, because PDF text
 * extraction breaks words apart ("ACTU AL") and no probe survives it.
 */
function sheetReport(_titles: string[], sheetText: string[]): string {
  const lines = sheetText.map((text, i) =>
    `  sheet ${i + 1}: ${text.replace(/\s+/g, ' ').trim().slice(0, 70)}`);
  return `${sheetText.length} sheets:\n${lines.join('\n')}`;
}
