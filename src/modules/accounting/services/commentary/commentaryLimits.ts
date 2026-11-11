/**
 * What a board pack's approved commentary may cost, in the page's own units.
 * Page 4 of the board pack joins EVERY approved row into one paragraph set on a
 * fixed sheet, and a page that overflows refuses the whole pack. So the limit
 * is on the pack, and the cost is page 4's own fill run on that paragraph
 * (`commentaryCost`): lines x the measure in ems, at the worse of the two prose
 * measures, each word at an upper bound on the width page 4's model sets it at
 * (`packProseBound`: the faces' advances plus their kerning, from a generated
 * table, so the font ruler never loads in the browser). ONE FUNCTION for every
 * layer — the service (on the rows it reads under the lock), the editor (on the
 * rows on screen) and the tests — so none can disagree about the pack, and none
 * can let through what page 4 then refuses. Client-safe on purpose.
 *
 * CALIBRATION (tests/unit/services/packs/packApprovedCommentaryCap.test.ts):
 * the cost page 4 holds before it refuses, on the tightest fixture
 * (`liveDemoShortPanelsInput`): 787 for capitals, digits, wide glyphs, long
 * words and words of 10 or 26 letters (the cost is the page's own line count,
 * so the capacity is a line count times the measure); prose 813, a URL 838,
 * CJK 939. Other fixtures hold 1083 to 1996. 760 sits 3% under the tightest,
 * which is only rounding margin (mm to lines), and is about 1450 characters of
 * prose.
 */
import { GUTTER_MM, PAGE_WIDTH_MM, PT_MM } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { proseLinesBound } from '@/modules/accounting/services/packs/pages/packProseBound';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';

/** The budget, in lines x line-ems of page 4's prose (see `commentaryCost`). */
export const MAX_APPROVED_PACK_EMS = 760;

/** What a pack that prints on no fixed page may carry in one edited row: a
 *  generous ceiling, not a layout limit — it only stops an unbounded body. */
export const MAX_UNBUDGETED_CHARS = 4000;

/**
 * The two measures page 4's prose is wrapped at (`narrativeMm`): the full
 * page when the block is stacked, two thirds of it beside the action panel.
 * A text must fit whichever the page ends up drawn in.
 */
const MEASURES_MM = [PAGE_WIDTH_MM.portrait, (PAGE_WIDTH_MM.portrait - GUTTER_MM) * (2 / 3)] as const;

/**
 * WHAT THE PACK'S APPROVED COMMENTARY COSTS: page 4's own fill
 * (`packProseFill`, at `packProseBound`'s widths, never under page 4's) run on
 * the paragraph page 4 prints — every approved row, trimmed, joined by one
 * space, in `section_ref, row_ref` order — at each of the two prose measures,
 * as lines x the measure in ems, the worse of the two. The gate's lines are
 * never fewer than the page's, so the editor, the service and the page agree.
 *
 * The JOINED text is costed, not each row: a per-row line ceiling charges every
 * row its half-empty last line, which over-counts by up to ~100 ems across
 * seven rows. Callers pass the texts in page order, with the row being
 * approved at its own position.
 */
export function commentaryCost(texts: ReadonlyArray<string>): number {
  const joined = texts.map((t) => t.trim()).filter((t) => t !== '').join(' ');
  if (joined === '') return 0;
  // Page 4's own fill at widths never under its own (`packProseBound`), as lines x the measure in ems of the body size.
  return Math.max(...MEASURES_MM.map((mm) => proseLinesBound(joined, PROSE.narrativeBody, mm) * (mm / (PROSE.narrativeBody.pt * PT_MM))));
}

/** Ordinary English prose costs ~0.51 a character (see the calibration): the conversion used only
 *  to tell a person roughly how much is left. The ems are what is enforced. */
const PROSE_EMS_PER_CHAR = 0.51;

/** "About N characters" of ordinary prose that `ems` of room holds. */
export function approxCharsLeft(ems: number): number {
  return Math.max(0, Math.floor(ems / PROSE_EMS_PER_CHAR));
}

/** What is stored: line endings as LF (a Windows paste or a CRLF API body is
 *  text, not an error), then trimmed. Validate and cost THIS, never the input. */
export function normaliseEditedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/** Characters that print as nothing and are not whitespace, `Cf` or a combining
 *  mark: the Hangul fillers and the blank braille cell. Combining marks (`\p{M}`:
 *  the Khmer inherent vowels U+17B4/17B5, the grapheme joiner U+034F, variation
 *  selectors U+FE00-FE0F and U+E0100-E01EF, Mongolian U+180B-180D) are stripped
 *  as a class below, so a text of marks alone is blank too. */
const BLANK_GLYPHS = '\u115f\u1160\u3164\uffa0\u2800';

/**
 * Why a text is not an approvable sentence, or null. Applied to what a person
 * types before it is stored: a NUL byte would make Postgres answer 500, a lone
 * surrogate cannot be stored as UTF-8, and a text of nothing but zero-width or
 * format characters is blank on the page while passing a trim.
 */
export function editedTextProblem(text: string): 'empty' | 'invalid' | null {
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) return 'invalid';
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) return 'invalid';
  if (text.replace(new RegExp(`[\\s\\p{Cf}\\p{M}${BLANK_GLYPHS}]`, 'gu'), '').length === 0) return 'empty';
  return null;
}
