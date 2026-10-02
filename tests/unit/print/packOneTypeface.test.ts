/**
 * ONE FAMILY, AND THE PDF IS WHAT SAYS SO.
 *
 * The rendered packs embedded THREE typefaces. `pdffonts` on both companies'
 * v51 renders:
 *
 *   IBMPlexSans / IBMPlexSans-Medm / IBMPlexSans-SmBld   body, tables, titles
 *   LiberationSans                                       every chart's text
 *   NotoSans-Regular                                     every page footer
 *
 * Neither of the last two was a choice. ECharts writes `font-family` as an
 * attribute on every `<text>` it emits and defaults it to the literal
 * `sans-serif`, which Chromium resolves against the system — so the chart
 * layer OVERRODE the page's face rather than inheriting it. Chromium draws the
 * footer template in a document of its own that inherits no stylesheet at all,
 * so `font-family:sans-serif` there resolved the same way, to a different
 * face. On the demo income statement the figure `1 431` printed twice on one
 * sheet — once in the Cost of sales row, once as the label on its own bar a
 * centimetre below — in two typefaces, with a visibly different `1`, `4` and
 * `3`.
 *
 * SO THE ASSERTION IS ON THE FILE, not on any source string. A model test can
 * be satisfied by a constant nothing reads; the fonts a PDF embeds are the
 * fonts a director's reader will paint with, and they are in the file as
 * `/BaseFont` names next to the subset tag Chromium generates. The renderer
 * only embeds a face it actually SET TYPE IN, so this goes red the moment any
 * position in the pack falls back — including a position added tomorrow.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { buildFooterHtml, PACK_CONFIDENTIALITY } from '@/lib/pdf/printFurniture';
import { brightsphereLiveInput, demoInput } from '../services/packs/fixtures/boardPackInputs';
import { liveDemoRenderedInput } from '../services/packs/fixtures/liveDemoBoardPack';
import { printBoardPack, withChromium } from './renderPackPdf';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';

/**
 * The families the pack DECLARES — `styles/packPrint.css` names one, at three
 * weights, and Chromium spells the two heavier ones with its own abbreviations
 * in the `/BaseFont` name.
 *
 * A LIST OF FAMILIES, NOT OF FACE NAMES: the assertion is "no second family",
 * so it must not go green on a fourth IBM Plex weight nobody asked for either.
 * Every entry here is a face `packPrint.css` declares.
 */
const DECLARED = ['IBMPlexSans', 'IBMPlexSans-Medm', 'IBMPlexSans-SmBld'];

/** Every font the PDF embeds, by the name in its `/BaseFont` entry with
 *  Chromium's six-letter subset tag stripped. */
function embeddedFonts(pdf: Buffer): string[] {
  const names = [...pdf.toString('latin1').matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/>\]]+)/g)]
    .map((m) => m[1]!);
  return [...new Set(names)].sort();
}

const FIXTURES: Array<[string, BoardPackInput]> = [
  ['the demo company', demoInput],
  // The two fixtures shaped like the packs the gate actually read: the live
  // demo company as the route composes it, and Brightsphere's own figures.
  // Both draw every chart kind the pack has — a bridge, a composition bar, a
  // full-width line and six small multiples — so no chart family can hide.
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['Brightsphere as the live route composed it', brightsphereLiveInput],
];

describe('the printed pack is set in one typeface', () => {
  it.each(FIXTURES)('embeds only the declared faces — %s', async (unused, input) => {
    const document = buildBoardPackPages(input);
    const footer = buildFooterHtml({
      companyName: 'ISAFlow Demo (Pty) Ltd',
      packLabel: 'Board Pack',
      period: '1 January 2026 to 7 September 2026',
      confidentiality: PACK_CONFIDENTIALITY,
      draft: true,
    });
    const printed = await withChromium((browser) => printBoardPack(document, browser, footer));

    const fonts = embeddedFonts(printed.pdf);
    // The fixture must actually contain the case — a pack that embedded
    // nothing would pass the assertion below vacuously.
    expect(fonts.length, 'the PDF embedded no fonts at all').toBeGreaterThan(0);
    expect(fonts, `fonts embedded: ${fonts.join(', ')}`).toEqual(
      fonts.filter((name) => DECLARED.includes(name)),
    );
  }, 180_000);
});
