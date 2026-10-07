/**
 * What a board pack's approved commentary may cost, in the page's own units.
 *
 * Page 4 of the board pack joins EVERY approved row into one paragraph set in
 * a fixed sheet, and a page that overflows refuses the whole pack. So the
 * limit is on the SUM, and it is measured with the ruler the page is fitted
 * with — `packTextMetrics.textWidthEms`, em widths per glyph class — rather than
 * with a character count, which let an all-caps or all-CJK text take 2x the
 * room of prose for the same number.
 *
 * ONE FUNCTION for every layer: the service (on the rows it reads under the
 * lock), the editor (on the rows on screen) and the tests all call
 * `commentaryEms`, so none of them can disagree about what a row costs.
 * Client-safe on purpose: `packTextMetrics` imports only `pdfTransport`,
 * which imports nothing.
 *
 * CALIBRATION (tests/unit/services/packs/packApprovedCommentaryCap.test.ts):
 * the cost of the joined text page 4 holds before it refuses, on the tightest
 * fixture (`liveDemoShortPanelsInput`), by kind of text: wide glyphs 619,
 * digits 620, prose/caps/long words 639, URL in prose 724, CJK 799, and
 * uniform words of 10 to 70 characters 620 to 1178. Words are charged by the
 * lines they take (`wordEms`), which is why unlike a plain ems sum these agree
 * within a few per cent. 560 sits 9% under the lowest, so every kind fits
 * every fixture, and gives about 1200 characters of prose.
 */
import {
  PAGE_WIDTH_MM, breakableWords, emsPerLine, textWidthEms,
} from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { GUTTER_MM } from '@/modules/accounting/services/packs/pages/packDisclosureHeight';

export const MAX_APPROVED_PACK_EMS = 560;

/** What a pack that prints on no fixed page may carry in one edited row: a
 *  generous ceiling, not a layout limit — it only stops an unbounded body. */
export const MAX_UNBUDGETED_CHARS = 4000;

/** The ems of one joining space between rows. */
const JOIN_EMS = textWidthEms(' ');

/**
 * The two measures page 4's prose is wrapped at (`narrativeMm`): the full
 * page when the block is stacked, two thirds of it beside the action panel.
 * A text must fit whichever the page ends up drawn in, so a word is charged at
 * the worse of the two.
 */
const LINE_EMS = [
  emsPerLine(10, PAGE_WIDTH_MM.portrait),
  emsPerLine(10, (PAGE_WIDTH_MM.portrait - GUTTER_MM) * (2 / 3)),
] as const;

/**
 * What a word really costs on a line of `line` ems, the way `wrapEms` sets it.
 * A word is not broken across lines unless it is wider than one, so a line
 * holds only `floor` of them and the rest of it is wasted: a word a little over
 * half a line wide takes the whole line (cost 2x its width). Charged as the
 * line's share, `line / k`, for a word of up to a line; a word wider than a
 * line breaks inside itself and is charged whole lines. Ordinary words are
 * charged about their width, which is why prose is nearly unaffected.
 */
function wordEms(width: number, line: number): number {
  if (width >= line) return Math.ceil(width / line) * line;
  return line / Math.floor((line + JOIN_EMS) / (width + JOIN_EMS));
}

/** What one approved row costs: its words charged as the page sets them, plus
 *  the space that joins it to the next, so a sum is never smaller than the
 *  joined paragraph. */
export function commentaryEms(text: string): number {
  let ems = JOIN_EMS;
  for (const word of breakableWords(text.trim())) {
    const width = textWidthEms(word);
    ems += Math.max(...LINE_EMS.map((line) => wordEms(width, line)));
  }
  return ems;
}

/** Ems already spent by the approved rows among `rows`. */
export function packEmsUsed(rows: ReadonlyArray<{ status: string; approvedText: string | null }>): number {
  return rows.reduce(
    (sum, r) => (r.status === 'approved' && r.approvedText !== null ? sum + commentaryEms(r.approvedText) : sum),
    0,
  );
}

/** Ordinary English prose costs ~0.45 a character (639 over 1433 characters
 *  on the calibration fixture): the conversion used only
 *  to tell a person roughly how much is left. The ems are what is enforced. */
const PROSE_EMS_PER_CHAR = 0.45;

/** "About N characters" of ordinary prose that `ems` of room holds. */
export function approxCharsLeft(ems: number): number {
  return Math.max(0, Math.floor(ems / PROSE_EMS_PER_CHAR));
}

/** What is stored: line endings as LF (a Windows paste or a CRLF API body is
 *  text, not an error), then trimmed. Validate and cost THIS, never the input. */
export function normaliseEditedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/** Characters that print as nothing but are not whitespace or `Cf`: the Hangul
 *  fillers, the blank braille cell, the Khmer inherent vowels, the combining
 *  grapheme joiner and the variation selectors. */
const BLANK_GLYPHS = '\u115f\u1160\u3164\uffa0\u2800\u17b4\u17b5\u034f\ufe00-\ufe0f';

/**
 * Why a text is not an approvable sentence, or null. Applied to what a person
 * types before it is stored: a NUL byte would make Postgres answer 500, a lone
 * surrogate cannot be stored as UTF-8, and a text of nothing but zero-width or
 * format characters is blank on the page while passing a trim.
 */
export function editedTextProblem(text: string): 'empty' | 'invalid' | null {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return 'invalid';
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) return 'invalid';
  if (text.replace(new RegExp(`[\\s\\p{Cf}${BLANK_GLYPHS}]`, 'gu'), '').length === 0) return 'empty';
  return null;
}
