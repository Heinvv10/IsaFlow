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
const NARROW = new Set([...'ijltfr.,;:\'"!|()[]{}-…/']);
/**
 * The en dash is NOT narrow, and it was in the set above.
 *
 * `formatMoney` prints every measured zero as one, so it is the single
 * commonest non-alphabetic glyph in the pack's tables and prose. Measured at
 * 0.632em in IBM Plex Sans at 9.5pt — the width of a digit, which is what an
 * en is — against the 0.34 it was charged. It is charged as a digit below.
 */
/** The two letters set wider than an en — `m` and `w`, and their capitals. */
const WIDE = new Set([...'mwMW']);

/** How wide one character is, in ems. */
function charEms(ch: string): number {
  if (ch === ' ') return EM_SPACE;
  if (WIDE.has(ch)) return EM_WIDE;
  if (NARROW.has(ch)) return EM_NARROW;
  if (ch >= '0' && ch <= '9' || ch === '\u2013') return EM_DIGIT;
  if (ch >= 'A' && ch <= 'Z') return EM_UPPER;
  if (ch <= '\u00ff') return EM_DEFAULT;
  if (ch >= '\u0370' && ch <= '\u04ff') return EM_CYRILLIC_GREEK;
  return EM_FULL;
}

/**
 * How wide a string is, in ems, as this model believes.
 *
 * Exported for `packTextRulerCalibration.test.ts`, which divides Chromium's
 * measured width by this to say how far off the em table is on the pack's own
 * sentences. A test that re-implemented the sum would calibrate its own copy
 * rather than the ruler the pages are budgeted with.
 */
export function textWidthEms(text: string): number {
  return textEms(text);
}

/** How wide a string is, in ems. */
function textEms(text: string): number {
  let ems = 0;
  for (const ch of text) ems += charEms(ch);
  return ems;
}

/**
 * The safety factor on every measure — AND IT IS NOT A SAFETY MARGIN. IT IS A
 * CALIBRATION CONSTANT, AND IT IS SOMETIMES TOO SMALL.
 *
 * It is documented as eight per cent of headroom over an em table meant to be
 * accurate. Measured against Chromium in the real face at 9.5pt, the table is
 * not accurate: it reads real pack prose 7.3% to 9.8% SHORT, so this factor is
 * set in the middle of the error it is supposed to cover rather than above it.
 * Six sentences the pack actually prints, as model-width over true width:
 *
 *   cash "no bridge is drawn"      0.9317   needs 1.073
 *   the rounding note              0.9240   needs 1.082
 *   the inventory caveat           0.9111   needs 1.098
 *   the debtor-days definition     0.9159   needs 1.092
 *   the scoring-basis pointer      0.9272   needs 1.079
 *   the trends scale note          0.9153   needs 1.093
 *
 * Four of the six need more than 1.08. The model survives because a shortfall
 * only costs a LINE when it tips a greedy fill over a break, which most
 * paragraphs do not — but Brightsphere's cash page does, and `millionsCashInput`
 * is that page: 195.6mm budgeted against 198.8mm of paper. See
 * `packTextRulerCalibration.test.ts`, which pins these ratios, and task 26's
 * fix report for why raising this constant is not a fix that can be taken here:
 * at 1.10 every fixture stays green and the LIVE Brightsphere pack loses four
 * basis-of-preparation facts, because page 12 has 1.8mm of headroom and a
 * blanket 2% buys the correction out of the reader's document.
 *
 * The correction and the thirteenth sheet are one decision, and it is not this
 * function's to take.
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
