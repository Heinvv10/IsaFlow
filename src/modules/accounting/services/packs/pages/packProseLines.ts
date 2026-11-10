/**
 * HOW MANY LINES A PIECE OF THE PACK'S PROSE TAKES, from the faces' own widths (#1261's prose follow-up).
 *
 * The em table (`packTextMetrics.wrappedLines`, removed) charged a character by its class, an average over the pack's wording:
 * "%" at 0.526em where IBM Plex Sans sets it at 0.96, a run of U+3000 at one 0.26em space, a break at U+2007 and U+FEFF
 * where production has none. This sets each word at its width as the ruler shapes it (`packFigureWidth.textExactPx`:
 * the face's advances and kerning at the style's size and weight), and fills lines as the print does
 * (`packProseFill.proseFill`). The style's size and weight come from `packProseStyles`, held to the CSS.
 *
 * A character the faces do not set is priced from the fallback tables (measured alone in production's image), as the
 * em model priced it: a KNOWN LIMIT, unreached by any fixture. A joined script (Syriac, Arabic, Mongolian) can set a run
 * wider joined than its letters alone (Syriac SADHE 7.52px alone, about 10.3px joined), so a long run of one in prose
 * can read a line short. Pricing every fallback glyph at the widest (7.25em) would be never short, but it cut the
 * dense pack's Japanese matters from 12 to 5 of 15 (#1261 round 2), so the tables stay.
 * Server-only: the ruler reads the faces.
 */
import { textExactPx } from './packFigureWidth';
import { proseFill, type ProseSegment } from './packProseFill';
import type { ProseStyle } from './packProseStyles';

export { PROSE_GUARD_PX, type ProseSegment } from './packProseFill';

/** The lines `text` (or its segments) takes set in `style`, `widthMm` wide. */
export function proseLines(text: string | readonly ProseSegment[], style: ProseStyle, widthMm: number): number {
  return proseFill(text, style, widthMm, (t, px, weight) => textExactPx(t, px, weight));
}
