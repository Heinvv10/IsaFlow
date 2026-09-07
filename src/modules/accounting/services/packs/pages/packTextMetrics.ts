/**
 * HOW WIDE THE PACK'S TEXT IS, AND HOW MANY LINES OF IT FIT ON A MEASURE.
 *
 * The typographic half of `packPageMetrics`, split off at the 300-line cap:
 * this file knows about ems and paper, and that one knows about blocks. It
 * transcribes `styles/packPrint.css`'s page geometry and IBM Plex Sans's own
 * advances, and it never reads the DOM — the composer runs server-side,
 * before any browser sees the document.
 *
 * WHAT IT IS FOR — the whole story, kept next to the numbers.
 *
 * `selectPrintedMatters` already had a line budget, because the matters
 * table was the block that overflowed the sheet the day someone looked. Then
 * the scorecard's cross-reference footnote overflowed, and put two lines of
 * grey 7.5pt on a sheet of its own with no title, in the middle of a pack
 * whose contents page indexes twelve items and whose footers count thirteen.
 * Then the trends page's "Panels not drawn" block overflowed, on a different
 * company, for the same reason. Three overflows, three blocks, one cause: a
 * budget that covered ONE of the things that grows with data.
 *
 * A fixture derived from one failure is shaped like that failure, and the
 * next overflow comes from whatever the fixture did not copy. So this file
 * does not model the block that overflowed last — it models EVERY block the
 * pack can put on a page, so `fitPageToBox` can decline to compose a page
 * that does not fit rather than leaving a browser to discover it.
 *
 * THE CONTRACT IS THAT IT NEVER UNDER-ESTIMATES. A model that is sometimes
 * low is a model that sometimes ships a thirteenth sheet, so every constant
 * below sits on the pessimistic side of what was measured, and
 * `packPageMetrics.test.ts` re-measures all of them — block by block, page by
 * page — against Chromium's own layout on every fixture the print harness
 * carries. An over-estimate costs a note that would have fitted; an
 * under-estimate costs the twelve-sheet contract. They are not symmetrical.
 *
 * NOTHING HERE READS THE DOM, and it cannot: the composer runs server-side,
 * before any browser sees the document. It reads `styles/packPrint.css`'s own
 * type scale, transcribed. A CSS change that moves a line-height moves this
 * file too — which is what the measurement test exists to force.
 */
import { PDF_MARGIN_MM } from '@/lib/pdf/pdfTransport';

export const PT_MM = 25.4 / 72;

/** The box one sheet gives a page, and the measure its text is set across —
 *  A4 in both orientations, less the margins the transports pass. The same
 *  arithmetic `.pack-page`'s `min-height` states in CSS, off the same single
 *  source of truth for the margin. */
export const PAGE_BOX_MM = {
  portrait: 297 - PDF_MARGIN_MM.top - PDF_MARGIN_MM.bottom,
  landscape: 210 - PDF_MARGIN_MM.top - PDF_MARGIN_MM.bottom,
} as const;

export const PAGE_WIDTH_MM = {
  portrait: 210 - PDF_MARGIN_MM.left - PDF_MARGIN_MM.right,
  landscape: 297 - PDF_MARGIN_MM.left - PDF_MARGIN_MM.right,
} as const;

export type PageOrientation = keyof typeof PAGE_BOX_MM;

/**
 * HOW WIDE A CHARACTER OF IBM PLEX SANS IS, in ems of the type size.
 *
 * NOT one average, and that is the correction that mattered. A single mean —
 * 0.437em across the pack's ordinary prose — under-counts every string the
 * pack builds out of identifiers: page 4's action panel carries check
 * failures naming a company UUID, and a run of digits is a third wider than
 * the letters the mean was taken over. The model called those items three
 * lines and Chromium set four, which is the direction that ships a
 * thirteenth sheet. Page titles carry figures for the same reason.
 *
 * The classes are coarse on purpose: this is a budget, not a shaper.
 * `packTextMetrics.test.ts` measures the table itself against Chromium across
 * nine scripts and four measures, and `packSheetCount.test.ts` measures its
 * consequence — the page model — against Chromium on every fixture. Neither
 * trusts the numbers below.
 */
const EM_SPACE = 0.26;
const EM_NARROW = 0.34;
const EM_DIGIT = 0.62;
const EM_UPPER = 0.68;
const EM_WIDE = 0.84;
const EM_DEFAULT = 0.47;
/**
 * Cyrillic and Greek, which are set a little wider than the Latin mean.
 * Measured at 0.55 and budgeted at 0.62.
 */
const EM_CYRILLIC_GREEK = 0.62;
/**
 * A full em — CJK, kana, Hangul, and anything else this table does not know.
 *
 * The table was fitted to English and handed `EM_DEFAULT` to every codepoint
 * outside it, so a Chinese sentence measured a little under half its width:
 * the model called a 34mm column two lines where Chromium set five. It
 * UNDER-read, which is the direction that puts a page on a second sheet, and
 * it is reachable with real data rather than hypothetical — the matters table
 * carries issue text and journal references straight out of a company's
 * ledger, typed by a person.
 *
 * The unknown-script case defaults HERE rather than to `EM_DEFAULT`, because
 * a script this file has not measured is one it must over-count.
 * `packTextMetrics.test.ts` holds all of it against Chromium's own layout, in
 * the real face, across nine scripts and four measures.
 */
const EM_FULL = 1;
/** Narrow glyphs: the letters set on a thin advance, and most punctuation. */
const NARROW = new Set([...'ijltfr.,;:\'"!|()[]{}-–…/']);
/** The two letters set wider than an en — `m` and `w`, and their capitals. */
const WIDE = new Set([...'mwMW']);

/** How wide one character is, in ems. */
function charEms(ch: string): number {
  if (ch === ' ') return EM_SPACE;
  if (WIDE.has(ch)) return EM_WIDE;
  if (NARROW.has(ch)) return EM_NARROW;
  if (ch >= '0' && ch <= '9') return EM_DIGIT;
  if (ch >= 'A' && ch <= 'Z') return EM_UPPER;
  if (ch <= '\u00ff') return EM_DEFAULT;
  if (ch >= '\u0370' && ch <= '\u04ff') return EM_CYRILLIC_GREEK;
  return EM_FULL;
}

/** How wide a string is, in ems. */
function textEms(text: string): number {
  let ems = 0;
  for (const ch of text) ems += charEms(ch);
  return ems;
}

/**
 * The safety factor on every measure.
 *
 * Eight per cent, and no more, because it is paid on every line of every page:
 * the accuracy is meant to come from the em table above and from wrapping on
 * WORDS, not from a fudge large enough to hide a modelling error. What it
 * covers is kerning and the semibold face a note's own lead-in is set in.
 */
const WIDTH_SAFETY = 1.08;

/** The ems of `pt`-sized text one `widthMm` line holds. */
function emsPerLine(pt: number, widthMm: number): number {
  return (widthMm / (pt * PT_MM)) / WIDTH_SAFETY;
}

/**
 * Lines a string takes at `pt` across `widthMm`. At least one — an empty
 * paragraph still occupies its line box.
 *
 * WORD BY WORD, not a division. A character count assumes text breaks
 * anywhere, and the pack's does not: an unbreakable 36-character identifier
 * pushes the line before it short, and the division cannot see it.
 */
export function wrappedLines(text: string, pt: number, widthMm: number): number {
  return wrapEms(text, emsPerLine(pt, widthMm));
}

/**
 * The same greedy wrap against a measure stated in CHARACTERS of ordinary
 * prose — which is how `packMattersPrinted` divides its five columns. One
 * character is `EM_DEFAULT` wide by definition here, so the two models share
 * a wrapper rather than a constant.
 */
export function linesForChars(text: string, perLine: number): number {
  return wrapEms(text, perLine * EM_DEFAULT);
}

function wrapEms(text: string, perLine: number): number {
  let count = 1;
  let used = 0;
  for (const word of text.split(/\s+/)) {
    if (word.length === 0) continue;
    const wordEms = textEms(word);
    const withWord = used === 0 ? wordEms : used + EM_SPACE + wordEms;
    if (withWord <= perLine) { used = withWord; continue; }
    if (used > 0) count += 1;
    used = wordEms;
    // A word wider than the measure breaks inside itself.
    while (used > perLine) { count += 1; used -= perLine; }
  }
  return count;
}

/** Millimetres of `n` lines set at a `lineHeightPt` leading. */
export function lines(n: number, lineHeightPt: number): number {
  return n * lineHeightPt * PT_MM;
}
