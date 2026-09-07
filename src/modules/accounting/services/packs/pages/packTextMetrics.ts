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
 * The safety factor on every measure — and it is a SAFETY FACTOR again.
 *
 * IT WAS NOT ONE. It was documented as eight per cent of headroom over an em
 * table meant to be accurate, and the table is not accurate: it reads the
 * pack's own prose SHORT, because a lowercase letter of this face averages
 * 0.53em and `EM_DEFAULT` charges 0.47. At 1.08 the factor sat INSIDE the
 * error it was there to cover, which made it a calibration constant that
 * happened to be too small — and every consumer treats `pageMm` as an upper
 * bound. `fitPageToBox` stops the moment the page fits and `assertFits`
 * re-checks against the same model, so an under-read page passed both and
 * Chromium found the thirteenth sheet. One live page already had:
 * Brightsphere's cash sheet, budgeted 234.7mm against 238.0mm of paper.
 *
 * WHERE 1.12 COMES FROM. Every string the ten print fixtures put on paper —
 * 344 of them over 20 ems — measured in Chromium in the real woff2 at each
 * size the pack wraps prose at, as Chromium's width over this model's:
 *
 *   7.5pt  needs up to 1.104    (page footnotes, ratio reasons)
 *   8.5pt  needs up to 1.065    (definitions, two-column notes)
 *   9pt    needs up to 1.099    (matters cells)
 *   9.5pt  needs up to 1.119    (disclosure notes — the pack's main prose)
 *   10pt   needs up to 1.063    (narrative bodies)
 *   13pt   needs up to 1.077    (landscape page titles)
 *   15pt   needs up to 1.093    (portrait page titles)
 *
 * 1.12 covers all of them. The 11pt measure — disclosure headings and the
 * definitions' group names — reads worse still, up to 1.137, and is NOT
 * covered: every 11pt string in the pack is under 20 ems against a measure of
 * 180mm or more, so none of them can reach a second line and the shortfall
 * cannot cost a break. That is the one hole, and it is named rather than
 * averaged away. A heading long enough to wrap makes it real, which is what
 * `packTextRulerCalibration.test.ts` exists to notice.
 *
 * WHAT IT COST, because it did cost. At 1.08 no content page of any fixture
 * was trimmed at all; at 1.12 pages 3, 5, 10 and 12 hand back prose on the
 * fixtures shaped like the live companies — see task 36's fix report for the
 * page-by-page list. Page 5 is the one that cannot pay: it drops a note from
 * a disclosure this pack is REQUIRED to make, on five of the ten fixtures.
 * That is a content decision about page 5 and not a reason to shorten the
 * ruler; the report carries it.
 */
export const WIDTH_SAFETY = 1.12;

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

/**
 * A "WORD" IS WHAT A BROWSER WILL NOT BREAK, WHICH IS NOT WHAT `\s` MATCHES.
 *
 * `formatMoney` separates thousands with U+00A0 so a figure cannot split
 * across a line at its own separator (see `GROUP_SEPARATOR`) — and JavaScript's
 * `\s` matches U+00A0, so a wrap model splitting on `/\s+/` would offer the
 * renderer a break the browser will never take. It would then under-count the
 * lines of any block carrying a figure in prose, which is the number every
 * page's fit is decided on.
 */
const BREAKABLE = /[^\S\u00a0\u202f]+/;

function wrapEms(text: string, perLine: number): number {
  let count = 1;
  let used = 0;
  for (const word of text.split(BREAKABLE)) {
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
