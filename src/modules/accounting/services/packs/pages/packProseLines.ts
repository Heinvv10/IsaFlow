/**
 * HOW MANY LINES A PIECE OF THE PACK'S PROSE TAKES, from the faces' own widths (#1261's prose follow-up).
 *
 * The em table (`packTextMetrics.wrappedLines`, removed) charged a character by its class, an average over the pack's wording:
 * "%" at 0.526em where IBM Plex Sans sets it at 0.96, a run of U+3000 at one 0.26em space, a break at U+2007 and U+FEFF
 * where production has none. This breaks where Chromium does (`packLineBreaks.pieces`) and sets each candidate line at
 * its width as the ruler shapes it (`packFigureWidth.textExactPx`: the face's advances and kerning at the style's size
 * and weight), filling lines as the print does (`packProseFill.proseFill`). The style's size and weight come from
 * `packProseStyles`, held to the CSS.
 *
 * A character the faces do not set is priced from the fallback tables (measured alone in production's image), as the
 * em model priced it: a KNOWN LIMIT, unreached by any fixture. A joined script (Syriac, Arabic, Mongolian) can set a run
 * wider joined than its letters alone (Syriac SADHE 7.52px alone, about 10.3px joined), so a long run of one in prose
 * can read a line short. Pricing every fallback glyph at the widest (7.25em) would be never short, but it cut the
 * dense pack's Japanese matters from 12 to 5 of 15 (#1261 round 2), so the tables stay. Likewise a run in a script
 * Chromium breaks by dictionary (Thai, Lao, Khmer, Myanmar) is kept whole where `pieces` sees no break in it, so a run
 * of one wider than its line is filled as if it broke anywhere, and can read a line short.
 * Server-only: the ruler reads the faces.
 */
import { textExactPx } from './packFigureWidth';
import { proseFill, type ProseSegment } from './packProseFill';
import type { ProseStyle, ProseWeight } from './packProseStyles';

export { PROSE_GUARD_PX, type ProseSegment } from './packProseFill';

/** The ruler's widths, kept across calls: a pack sets the same words and joins on every page and every fit attempt. */
const WIDTHS = new Map<string, number>();
const WIDTHS_KEPT = 200_000;

function exactPx(text: string, px: number, weight: ProseWeight, hyphen: boolean): number {
  const key = `${weight}|${px}|${hyphen ? 1 : 0}|${text}`;
  let width = WIDTHS.get(key);
  if (width === undefined) {
    if (WIDTHS.size >= WIDTHS_KEPT) WIDTHS.clear();
    width = textExactPx(text, px, weight, hyphen);
    WIDTHS.set(key, width);
  }
  return width;
}

/** The lines `text` (or its segments) takes set in `style`, `widthMm` wide. */
export function proseLines(text: string | readonly ProseSegment[], style: ProseStyle, widthMm: number): number {
  return proseFill(text, style, widthMm, exactPx);
}
