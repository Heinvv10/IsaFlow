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
 * the joined ems page 4 holds before it refuses, on the tightest fixture
 * (`liveDemoShortPanelsInput`), by kind of text: prose 599, caps 588, wide
 * glyphs 588, digits 582, long words 561, URL 617, CJK 463. CJK is lowest
 * because the wrap model charges an unbreakable run a whole line per word
 * boundary. 420 leaves at least 9% under the lowest, so every kind fits.
 * Prose gets about 1000 characters out of it; a Latin-only deployment could
 * raise it toward 540 and keep the same margin.
 */
import { textWidthEms } from '@/modules/accounting/services/packs/pages/packTextMetrics';

export const MAX_APPROVED_PACK_EMS = 420;

/** The ems of one joining space between rows. */
const JOIN_EMS = textWidthEms(' ');

/** What one approved row costs: its trimmed width plus the space that joins it
 *  to the next, so a sum is never smaller than the joined paragraph. */
export function commentaryEms(text: string): number {
  return textWidthEms(text.trim()) + JOIN_EMS;
}

/** Ems already spent by the approved rows among `rows`. */
export function packEmsUsed(rows: ReadonlyArray<{ status: string; approvedText: string | null }>): number {
  return rows.reduce(
    (sum, r) => (r.status === 'approved' && r.approvedText !== null ? sum + commentaryEms(r.approvedText) : sum),
    0,
  );
}

/** Ordinary English prose averages ~0.42em a character in this face (599 ems
 *  over 1433 characters on the calibration fixture): the conversion used only
 *  to tell a person roughly how much is left. The ems are what is enforced. */
const PROSE_EMS_PER_CHAR = 0.42;

/** "About N characters" of ordinary prose that `ems` of room holds. */
export function approxCharsLeft(ems: number): number {
  return Math.max(0, Math.floor(ems / PROSE_EMS_PER_CHAR));
}

/**
 * Why a text is not an approvable sentence, or null. Applied to what a person
 * types before it is stored: a NUL byte would make Postgres answer 500, a lone
 * surrogate cannot be stored as UTF-8, and a text of nothing but zero-width or
 * format characters is blank on the page while passing a trim.
 */
export function editedTextProblem(text: string): 'empty' | 'invalid' | null {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return 'invalid';
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) return 'invalid';
  if (text.replace(/[\s\p{Cf}]/gu, '').length === 0) return 'empty';
  return null;
}
